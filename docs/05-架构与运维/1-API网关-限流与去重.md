---
editLink: true
lastUpdated: true
---
# API 网关 - 限流与去重

## 概述

API 网关是实施幂等性的第一道防线。通过在网关层进行限流和去重，可以：
1. **保护后端服务**：避免重复请求冲击
2. **快速失败**：在网关层直接拒绝重复请求
3. **统一策略**：集中管理幂等性规则

## 架构设计

```
客户端 → API Gateway → 后端服务
            ↓
      ┌─────────────┐
      │ 限流模块     │ ← 控制请求频率
      ├─────────────┤
      │ 去重模块     │ ← 检测重复请求
      ├─────────────┤
      │ 认证授权     │ ← 验证身份
      └─────────────┘
```

## YARP 网关实现

### 1. 安装 YARP

```bash
dotnet add package Yarp.ReverseProxy
```

### 2. 配置代理

```json
// appsettings.json
{
  "ReverseProxy": {
    "Routes": {
      "orders-route": {
        "ClusterId": "orders-cluster",
        "Match": {
          "Path": "/api/orders/{**catch-all}"
        },
        "Transforms": [
          { "PathRemovePrefix": "/api" }
        ]
      }
    },
    "Clusters": {
      "orders-cluster": {
        "Destinations": {
          "destination1": {
            "Address": "http://localhost:5001/"
          }
        }
      }
    }
  }
}
```

### 3. 限流中间件

```csharp
using System.Collections.Concurrent;

public class RateLimitingMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<RateLimitingMiddleware> _logger;
    
    // 每个用户的请求计数
    private readonly ConcurrentDictionary<string, RequestCounter> _counters = new();
    
    public RateLimitingMiddleware(RequestDelegate next, ILogger<RateLimitingMiddleware> logger)
    {
        _next = next;
        _logger = logger;
    }
    
    public async Task InvokeAsync(HttpContext context)
    {
        var userId = context.User.FindFirst("sub")?.Value 
                     ?? context.Connection.RemoteIpAddress?.ToString() 
                     ?? "anonymous";
        
        var key = $"{userId}:{context.Request.Path}";
        
        // 获取或创建计数器
        var counter = _counters.GetOrAdd(key, _ => new RequestCounter());
        
        // 检查限流
        if (!counter.AllowRequest())
        {
            _logger.LogWarning("Rate limit exceeded for user {UserId} on {Path}", 
                userId, context.Request.Path);
            
            context.Response.StatusCode = StatusCodes.Status429TooManyRequests;
            context.Response.Headers.Add("Retry-After", "60");
            
            await context.Response.WriteAsJsonAsync(new
            {
                error = "Too many requests",
                message = "Please slow down and try again later"
            });
            
            return;
        }
        
        await _next(context);
    }
}

public class RequestCounter
{
    private int _count = 0;
    private DateTime _windowStart = DateTime.UtcNow;
    private readonly object _lock = new();
    
    private const int MaxRequests = 100; // 每个窗口最大请求数
    private static readonly TimeSpan WindowSize = TimeSpan.FromMinutes(1);
    
    public bool AllowRequest()
    {
        lock (_lock)
        {
            var now = DateTime.UtcNow;
            
            // 重置窗口
            if (now - _windowStart >= WindowSize)
            {
                _count = 0;
                _windowStart = now;
            }
            
            // 检查是否超过限制
            if (_count >= MaxRequests)
            {
                return false;
            }
            
            _count++;
            return true;
        }
    }
}
```

### 4. 请求去重中间件

```csharp
public class RequestDeduplicationMiddleware
{
    private readonly RequestDelegate _next;
    private readonly IDistributedCache _cache;
    private readonly ILogger<RequestDeduplicationMiddleware> _logger;
    
    public RequestDeduplicationMiddleware(
        RequestDelegate next,
        IDistributedCache cache,
        ILogger<RequestDeduplicationMiddleware> logger)
    {
        _next = next;
        _cache = cache;
        _logger = logger;
    }
    
    public async Task InvokeAsync(HttpContext context)
    {
        // 仅处理 POST/PUT/PATCH 请求
        if (!IsWriteMethod(context.Request.Method))
        {
            await _next(context);
            return;
        }
        
        // 获取请求指纹
        var requestFingerprint = await GenerateRequestFingerprint(context);
        var cacheKey = $"dedup:{requestFingerprint}";
        
        // 检查是否已处理过
        var existingResponse = await _cache.GetStringAsync(cacheKey);
        
        if (!string.IsNullOrEmpty(existingResponse))
        {
            _logger.LogInformation("Duplicate request detected: {Fingerprint}", requestFingerprint);
            
            // 返回缓存的响应
            context.Response.ContentType = "application/json";
            context.Response.Headers.Add("X-Cache", "HIT");
            await context.Response.WriteAsync(existingResponse);
            return;
        }
        
        // 捕获响应
        var originalBodyStream = context.Response.Body;
        using var responseBody = new MemoryStream();
        context.Response.Body = responseBody;
        
        try
        {
            // 继续处理请求
            await _next(context);
            
            // 如果响应成功，缓存结果
            if (context.Response.StatusCode >= 200 && context.Response.StatusCode < 300)
            {
                responseBody.Seek(0, SeekOrigin.Begin);
                var responseContent = await new StreamReader(responseBody).ReadToEndAsync();
                
                // 缓存 5 分钟
                await _cache.SetStringAsync(
                    cacheKey,
                    responseContent,
                    new DistributedCacheEntryOptions
                    {
                        AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(5)
                    });
                
                responseBody.Seek(0, SeekOrigin.Begin);
            }
            
            // 写回响应
            responseBody.Seek(0, SeekOrigin.Begin);
            await responseBody.CopyToAsync(originalBodyStream);
        }
        finally
        {
            context.Response.Body = originalBodyStream;
        }
    }
    
    private bool IsWriteMethod(string method)
    {
        return method.Equals(HttpMethods.Post, StringComparison.OrdinalIgnoreCase) ||
               method.Equals(HttpMethods.Put, StringComparison.OrdinalIgnoreCase) ||
               method.Equals(HttpMethods.Patch, StringComparison.OrdinalIgnoreCase);
    }
    
    private async Task<string> GenerateRequestFingerprint(HttpContext context)
    {
        // 读取请求体
        context.Request.EnableBuffering();
        var body = await new StreamReader(context.Request.Body).ReadToEndAsync();
        context.Request.Body.Position = 0;
        
        // 生成指纹：HTTP方法 + 路径 + 用户ID + 请求体哈希
        var userId = context.User.FindFirst("sub")?.Value ?? "anonymous";
        var data = $"{context.Request.Method}:{context.Request.Path}:{userId}:{body}";
        
        using var sha256 = SHA256.Create();
        var hash = sha256.ComputeHash(Encoding.UTF8.GetBytes(data));
        return Convert.ToHexString(hash)[..32].ToLowerInvariant();
    }
}
```

### 5. 注册中间件

```csharp
// Program.cs
var builder = WebApplication.CreateBuilder(args);

// 添加 YARP
builder.Services.AddReverseProxy()
    .LoadFromConfig(builder.Configuration.GetSection("ReverseProxy"));

// 添加分布式缓存（用于去重）
builder.Services.AddStackExchangeRedisCache(options =>
{
    options.Configuration = builder.Configuration["Redis:ConnectionString"];
});

var app = builder.Build();

// 注册中间件（顺序很重要）
app.UseAuthentication();
app.UseAuthorization();
app.UseMiddleware<RateLimitingMiddleware>();  // 限流
app.UseMiddleware<RequestDeduplicationMiddleware>();  // 去重

// YARP 代理
app.MapReverseProxy();

app.Run();
```

## Kong 网关实现

### 1. 安装限流插件

```bash
# 启用限流插件
curl -X POST http://localhost:8001/plugins \
  --data "name=rate-limiting" \
  --data "config.second=10" \
  --data "config.minute=100" \
  --data "config.policy=redis" \
  --data "config.redis_host=localhost" \
  --data "config.redis_port=6379"
```

### 2. 配置请求去重

```lua
-- custom-deduplication.lua
local redis = require "resty.redis"
local red = redis:new()

red:set_timeout(1000)
red:connect("127.0.0.1", 6379)

local function generate_fingerprint()
    local ngx = ngx
    local method = ngx.req.get_method()
    local uri = ngx.var.uri
    local body = ngx.req.get_body_data() or ""
    
    local str = require "resty.string"
    local sha256 = require "resty.sha256"
    
    local digest = sha256:new()
    digest:update(method .. uri .. body)
    local sha256_hex = str.to_hex(digest:final())
    
    return sha256_hex
end

local fingerprint = generate_fingerprint()
local key = "dedup:" .. fingerprint

-- 检查是否已存在
local exists = red:get(key)
if exists then
    ngx.status = 200
    ngx.say(exists)
    return ngx.exit(200)
end

-- 继续处理请求
ngx.req.read_body()
local body = ngx.req.get_body_data()

-- 调用后端服务
local http = require "resty.http"
local httpc = http:new()
local res = httpc:request_uri("http://backend:5000" .. ngx.var.uri, {
    method = ngx.req.get_method(),
    body = body,
    headers = ngx.req.get_headers()
})

if res.status >= 200 and res.status < 300 then
    -- 缓存响应 5 分钟
    red:setex(key, 300, res.body)
end

ngx.status = res.status
for k, v in pairs(res.headers) do
    ngx.header[k] = v
end
ngx.say(res.body)
```

## 监控与告警

### 1. 指标收集

```csharp
public class GatewayMetrics
{
    private readonly Counter<long> _requestsTotal;
    private readonly Counter<long> _rateLimitedRequests;
    private readonly Counter<long> _duplicateRequests;
    private readonly Histogram<double> _requestDuration;
    
    public void RecordRequest(bool rateLimited, bool duplicate, double durationMs)
    {
        _requestsTotal.Add(1);
        
        if (rateLimited)
        {
            _rateLimitedRequests.Add(1);
        }
        
        if (duplicate)
        {
            _duplicateRequests.Add(1);
        }
        
        _requestDuration.Record(durationMs);
    }
}
```

### 2. Prometheus 配置

```yaml
scrape_configs:
  - job_name: 'api-gateway'
    static_configs:
      - targets: ['gateway:5000']
    metrics_path: '/metrics'
```

## 最佳实践总结

### ✅ DO

1. **分层防护**：网关 + 应用层双重保障
2. **合理限流**：根据业务场景设置阈值
3. **快速失败**：在网关层拒绝无效请求
4. **监控告警**：及时发现异常流量
5. **灰度发布**：逐步调整限流策略

### ❌ DON'T

1. **不要过度限流**：影响正常用户体验
2. **不要忽略白名单**：为重要用户放行
3. **不要忘记清理缓存**：避免内存泄漏
4. **不要硬编码配置**：使用动态配置

## 总结

API 网关层的限流与去重是幂等性的第一道防线：

✅ **YARP 实现**：灵活、可定制  
✅ **Kong 实现**：开箱即用、插件丰富  
✅ **性能优化**：减少后端压力  
✅ **统一策略**：集中管理规则  

通过网关层的防护，可以有效保护后端服务，提升系统整体稳定性。
