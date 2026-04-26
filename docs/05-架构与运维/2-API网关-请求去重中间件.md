---
editLink: true
lastUpdated: true
---
# API网关 - 请求去重中间件

## 目录
- [1. 概述](#1-概述)
- [2. YARP 反向代理](#2-yarp-反向代理)
- [3. Kong 网关插件](#3-kong-网关插件)
- [4. Ocelot 网关](#4-ocelot-网关)
- [5. 自定义中间件](#5-自定义中间件)
- [6. 最佳实践](#6-最佳实践)

---

## 1. 概述

### 1.1 为什么在网关层做去重？

API 网关是系统的入口，在这里实现请求去重有诸多优势：

**优势**：
- ✅ **提前拦截**：在请求到达业务服务前就拦截重复请求
- ✅ **统一处理**：所有服务共享同一套去重逻辑
- ✅ **减轻后端压力**：减少不必要的网络调用和数据库查询
- ✅ **集中监控**：统一监控和告警

**适用场景**：
- 微服务架构
- 高并发 API
- 移动端接口（网络不稳定）
- 第三方 webhook 接收

### 1.2 去重策略对比

| 策略 | 优点 | 缺点 | 适用场景 |
|------|------|------|---------|
| **基于请求ID** | 简单可靠 | 需客户端配合 | API 调用 |
| **基于指纹** | 自动识别 | 可能误判 | 表单提交 |
| **基于Token** | 精确控制 | 需额外请求 | 敏感操作 |
| **混合模式** | 灵活全面 | 实现复杂 | 综合场景 |

---

## 2. YARP 反向代理

### 2.1 安装 YARP

```bash
dotnet add package Yarp.ReverseProxy
```

### 2.2 基础配置

```json
{
  "ReverseProxy": {
    "Routes": {
      "api-route": {
        "ClusterId": "api-cluster",
        "Match": {
          "Path": "/api/{**catch-all}"
        }
      }
    },
    "Clusters": {
      "api-cluster": {
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

### 2.3 请求去重 Transform

```csharp
using Yarp.ReverseProxy.Transforms;
using StackExchange.Redis;

namespace Idempotency.YarpGateway.Transforms
{
    public class RequestDeduplicationTransform : ITransformProvider
    {
        private readonly IDatabase _redis;
        
        public RequestDeduplicationTransform(IConnectionMultiplexer redis)
        {
            _redis = redis.GetDatabase();
        }
        
        public void Apply(TransformBuilderContext transformBuildContext)
        {
            // 添加自定义中间件到管道
            transformBuildContext.AddRequestTransform(async transformContext =>
            {
                var httpContext = transformContext.ProxyContext.HttpContext;
                
                // 提取请求ID
                if (httpContext.Request.Headers.TryGetValue("X-Request-ID", out var requestId))
                {
                    var cacheKey = $"dedup:{requestId}";
                    
                    // 检查是否重复
                    var exists = await _redis.StringSetAsync(
                        cacheKey, 
                        "1", 
                        TimeSpan.FromMinutes(5),
                        When.NotExists);
                    
                    if (!exists)
                    {
                        // 重复请求，直接返回
                        httpContext.Response.StatusCode = StatusCodes.Status409Conflict;
                        httpContext.Response.ContentType = "application/json";
                        
                        var response = new { error = "Duplicate request" };
                        var json = JsonSerializer.Serialize(response);
                        
                        await httpContext.Response.WriteAsync(json);
                        
                        // 阻止请求转发
                        transformContext.ProxyRequest = null;
                        return;
                    }
                }
            });
        }
        
        public ValueTask<bool> CheckValidAsync()
        {
            return new ValueTask<bool>(true);
        }
    }
}
```

### 2.4 注册 Transform

```csharp
// Program.cs
var builder = WebApplication.CreateBuilder(args);

// Redis
builder.Services.AddSingleton<IConnectionMultiplexer>(sp =>
{
    var config = builder.Configuration.GetConnectionString("Redis");
    return ConnectionMultiplexer.Connect(config);
});

// YARP with custom transform
builder.Services.AddReverseProxy()
    .LoadFromConfig(builder.Configuration.GetSection("ReverseProxy"))
    .AddTransforms<RequestDeduplicationTransform>();

var app = builder.Build();

app.MapReverseProxy();
app.Run();
```

---

## 3. Kong 网关插件

### 3.1 Lua 插件实现

```lua
-- /usr/local/share/lua/5.1/kong/plugins/request-deduplication/handler.lua

local redis = require "resty.redis"
local cjson = require "cjson"

local DeduplicationHandler = {
    VERSION = "1.0.0",
    PRIORITY = 1000
}

function DeduplicationHandler:access(conf)
    local kong = kong
    local ngx = ngx
    
    -- 获取请求ID
    local request_id = kong.request.get_header("x-request-id")
    
    if not request_id then
        -- 如果没有请求ID，可以选择拒绝或放行
        if conf.require_request_id then
            kong.response.exit(400, cjson.encode({
                error = "Missing X-Request-ID header"
            }))
            return
        end
        
        return
    end
    
    -- 连接 Redis
    local red = redis:new()
    red:set_timeout(conf.redis_timeout or 1000)
    
    local ok, err = red:connect(conf.redis_host, conf.redis_port)
    if not ok then
        kong.log.err("Failed to connect to Redis: ", err)
        return
    end
    
    -- 如果配置了密码
    if conf.redis_password and conf.redis_password ~= "" then
        red:auth(conf.redis_password)
    end
    
    -- 选择数据库
    if conf.redis_database then
        red:select(conf.redis_database)
    end
    
    -- 检查是否重复
    local cache_key = conf.key_prefix .. request_id
    local ok, err = red:setnx(cache_key, "1")
    
    if not ok then
        kong.log.err("Failed to set key: ", err)
        return
    end
    
    if ok == 0 then
        -- 键已存在，重复请求
        kong.log.info("Duplicate request detected: ", request_id)
        
        -- 设置响应头
        kong.response.set_header("X-Duplicate-Request", "true")
        
        -- 返回 409 Conflict
        kong.response.exit(409, cjson.encode({
            error = "Duplicate request",
            request_id = request_id
        }))
        return
    end
    
    -- 设置过期时间
    red:expire(cache_key, conf.ttl or 300)
    
    -- 关闭 Redis 连接
    red:set_keepalive(10000, 100)
    
    -- 设置响应头
    kong.response.set_header("X-Request-Processed", "true")
end

return DeduplicationHandler
```

### 3.2 Schema 定义

```lua
-- /usr/local/share/lua/5.1/kong/plugins/request-deduplication/schema.lua

local typedefs = require "kong.db.schema.typedefs"

return {
    name = "request-deduplication",
    fields = {
        { consumer = typedefs.no_consumer },
        { protocols = typedefs.protocols_http },
        { config = {
            type = "record",
            fields = {
                { redis_host = { 
                    type = "string", 
                    default = "127.0.0.1" 
                }},
                { redis_port = { 
                    type = "number", 
                    default = 6379 
                }},
                { redis_password = { 
                    type = "string", 
                    required = false,
                    referenceable = true 
                }},
                { redis_database = { 
                    type = "number", 
                    default = 0 
                }},
                { redis_timeout = { 
                    type = "number", 
                    default = 1000 
                }},
                { ttl = { 
                    type = "number", 
                    default = 300 
                }},
                { key_prefix = { 
                    type = "string", 
                    default = "dedup:" 
                }},
                { require_request_id = { 
                    type = "boolean", 
                    default = false 
                }},
            },
        }},
    },
}
```

### 3.3 启用插件

```bash
# 全局启用
curl -X POST http://localhost:8001/plugins \
  --data "name=request-deduplication" \
  --data "config.redis_host=127.0.0.1" \
  --data "config.redis_port=6379" \
  --data "config.ttl=300"

# 为特定服务启用
curl -X POST http://localhost:8001/services/my-service/plugins \
  --data "name=request-deduplication" \
  --data "config.ttl=600"

# 为特定路由启用
curl -X POST http://localhost:8001/routes/my-route/plugins \
  --data "name=request-deduplication"
```

---

## 4. Ocelot 网关

### 4.1 安装 Ocelot

```bash
dotnet add package Ocelot
```

### 4.2 配置文件

```json
{
  "Routes": [
    {
      "DownstreamPathTemplate": "/api/{everything}",
      "DownstreamScheme": "http",
      "DownstreamHostAndPorts": [
        {
          "Host": "localhost",
          "Port": 5001
        }
      ],
      "UpstreamPathTemplate": "/api/{everything}",
      "UpstreamHttpMethod": [ "GET", "POST", "PUT", "DELETE" ]
    }
  ],
  "GlobalConfiguration": {
    "BaseUrl": "http://localhost:5000"
  }
}
```

### 4.3 去重中间件

```csharp
using Ocelot.Middleware;
using StackExchange.Redis;

namespace Idempotency.OcelotGateway.Middleware
{
    public class RequestDeduplicationMiddleware
    {
        private readonly OcelotRequestDelegate _next;
        private readonly IDatabase _redis;
        
        public RequestDeduplicationMiddleware(
            OcelotRequestDelegate next,
            IConnectionMultiplexer redis)
        {
            _next = next;
            _redis = redis.GetDatabase();
        }
        
        public async Task Invoke(HttpContext context)
        {
            // 只处理 POST/PUT 请求
            var method = context.Request.Method.ToUpperInvariant();
            if (method != "POST" && method != "PUT")
            {
                await _next.Invoke(context);
                return;
            }
            
            // 提取请求ID
            if (!context.Request.Headers.TryGetValue("X-Request-ID", out var requestId))
            {
                context.Response.StatusCode = 400;
                await context.Response.WriteAsync("Missing X-Request-ID header");
                return;
            }
            
            // 检查是否重复
            var cacheKey = $"dedup:{requestId}";
            var isNew = await _redis.StringSetAsync(
                cacheKey, 
                "1", 
                TimeSpan.FromMinutes(5),
                When.NotExists);
            
            if (!isNew)
            {
                context.Response.StatusCode = 409;
                context.Response.ContentType = "application/json";
                
                var response = JsonSerializer.Serialize(new {
                    error = "Duplicate request",
                    request_id = requestId.ToString()
                });
                
                await context.Response.WriteAsync(response);
                return;
            }
            
            // 继续处理
            await _next.Invoke(context);
        }
    }
}
```

### 4.4 注册中间件

```csharp
// Program.cs
var builder = WebApplication.CreateBuilder(args);

// Redis
builder.Services.AddSingleton<IConnectionMultiplexer>(sp =>
{
    var config = builder.Configuration.GetConnectionString("Redis");
    return ConnectionMultiplexer.Connect(config);
});

// Ocelot
builder.Services.AddOcelot();

var app = builder.Build();

// 使用去重中间件
app.UseMiddleware<RequestDeduplicationMiddleware>();

// 使用 Ocelot
await app.UseOcelot();

app.Run();
```

---

## 5. 自定义中间件

### 5.1 ASP.NET Core 通用中间件

```csharp
namespace Idempotency.Gateway.Middleware
{
    public class AdvancedRequestDeduplicationMiddleware
    {
        private readonly RequestDelegate _next;
        private readonly IDatabase _redis;
        private readonly DeduplicationOptions _options;
        private readonly ILogger<AdvancedRequestDeduplicationMiddleware> _logger;
        
        public AdvancedRequestDeduplicationMiddleware(
            RequestDelegate next,
            IConnectionMultiplexer redis,
            DeduplicationOptions options,
            ILogger<AdvancedRequestDeduplicationMiddleware> logger)
        {
            _next = next;
            _redis = redis.GetDatabase();
            _options = options;
            _logger = logger;
        }
        
        public async Task InvokeAsync(HttpContext context)
        {
            // 检查是否需要去重
            if (!ShouldDeduplicate(context))
            {
                await _next(context);
                return;
            }
            
            // 提取请求标识
            var requestId = ExtractRequestId(context);
            if (string.IsNullOrEmpty(requestId))
            {
                if (_options.RequireRequestId)
                {
                    context.Response.StatusCode = StatusCodes.Status400BadRequest;
                    await context.Response.WriteAsync("X-Request-ID header is required");
                    return;
                }
                
                await _next(context);
                return;
            }
            
            // 构建缓存键
            var cacheKey = $"{_options.KeyPrefix}{requestId}";
            
            // 尝试设置（原子操作）
            var isNew = await _redis.StringSetAsync(
                cacheKey,
                "1",
                _options.Ttl,
                When.NotExists);
            
            if (!isNew)
            {
                _logger.LogWarning("Duplicate request blocked: {RequestId}", requestId);
                
                context.Response.StatusCode = StatusCodes.Status409Conflict;
                context.Response.ContentType = "application/json";
                context.Response.Headers["X-Duplicate-Request"] = "true";
                
                var response = new
                {
                    error = "Duplicate request detected",
                    request_id = requestId,
                    timestamp = DateTime.UtcNow
                };
                
                await context.Response.WriteAsJsonAsync(response);
                return;
            }
            
            // 设置响应头
            context.Response.Headers["X-Request-Idempotent"] = "true";
            
            // 继续处理
            await _next(context);
        }
        
        private bool ShouldDeduplicate(HttpContext context)
        {
            // 检查方法
            if (!_options.Methods.Contains(context.Request.Method, StringComparer.OrdinalIgnoreCase))
            {
                return false;
            }
            
            // 检查路径排除
            var path = context.Request.Path.Value?.ToLowerInvariant();
            if (_options.ExcludedPaths.Any(p => path?.StartsWith(p) == true))
            {
                return false;
            }
            
            return true;
        }
        
        private string? ExtractRequestId(HttpContext context)
        {
            // 从 Header 获取
            if (context.Request.Headers.TryGetValue("X-Request-ID", out var headerValue))
            {
                return headerValue.ToString();
            }
            
            // 从 Query String 获取
            if (context.Request.Query.TryGetValue("request_id", out var queryValue))
            {
                return queryValue.ToString();
            }
            
            return null;
        }
    }
    
    public class DeduplicationOptions
    {
        public string KeyPrefix { get; set; } = "dedup:";
        public TimeSpan Ttl { get; set; } = TimeSpan.FromMinutes(5);
        public List<string> Methods { get; set; } = new() { "POST", "PUT" };
        public List<string> ExcludedPaths { get; set; } = new() { "/health", "/metrics" };
        public bool RequireRequestId { get; set; } = false;
    }
}
```

### 5.2 扩展方法

```csharp
namespace Microsoft.AspNetCore.Builder
{
    public static class RequestDeduplicationExtensions
    {
        public static IApplicationBuilder UseRequestDeduplication(
            this IApplicationBuilder app,
            Action<DeduplicationOptions>? configure = null)
        {
            var options = new DeduplicationOptions();
            configure?.Invoke(options);
            
            var redis = app.ApplicationServices.GetRequiredService<IConnectionMultiplexer>();
            var logger = app.ApplicationServices.GetRequiredService<
                ILogger<AdvancedRequestDeduplicationMiddleware>>();
            
            return app.UseMiddleware<AdvancedRequestDeduplicationMiddleware>(
                redis, options, logger);
        }
    }
}
```

### 5.3 使用

```csharp
// Program.cs
var app = builder.Build();

app.UseRequestDeduplication(options =>
{
    options.Ttl = TimeSpan.FromMinutes(10);
    options.Methods = new() { "POST", "PUT", "DELETE" };
    options.ExcludedPaths = new() { "/webhooks", "/health" };
    options.RequireRequestId = true;
});

app.Run();
```

---

## 6. 最佳实践

### 6.1 选择合适的去重粒度

```csharp
// ✅ 推荐：细粒度（基于请求ID）
var cacheKey = $"dedup:{requestId}";

// ❌ 避免：粗粒度（所有请求共用一个键）
var cacheKey = "dedup:global";
```

### 6.2 设置合理的 TTL

```csharp
// 根据业务场景设置
var shortTtl = TimeSpan.FromMinutes(1);   // 高频 API
var normalTtl = TimeSpan.FromMinutes(5);  // 普通 API
var longTtl = TimeSpan.FromHours(1);      // 敏感操作
```

### 6.3 监控去重效果

```csharp
public class DeduplicationMetrics
{
    private readonly Counter<long> _requestsTotal;
    private readonly Counter<long> _duplicatesBlocked;
    private readonly Gauge<double> _duplicateRate;
    
    public void RecordRequest(bool isDuplicate)
    {
        _requestsTotal.Add(1);
        
        if (isDuplicate)
        {
            _duplicatesBlocked.Add(1);
        }
        
        // 计算重复率
        var rate = (double)_duplicatesBlocked.CurrentCount / 
                   _requestsTotal.CurrentCount;
        _duplicateRate.Record(rate);
    }
}
```

### 6.4 分级去重策略

```csharp
// 不同 API 使用不同的去重策略
public class TieredDeduplicationMiddleware
{
    private async Task<TimeSpan> GetTtlForRequest(HttpContext context)
    {
        var path = context.Request.Path.Value?.ToLowerInvariant();
        
        return path switch
        {
            var p when p.Contains("/payment") => TimeSpan.FromHours(1),
            var p when p.Contains("/order") => TimeSpan.FromMinutes(10),
            var p when p.Contains("/product") => TimeSpan.FromMinutes(1),
            _ => TimeSpan.FromMinutes(5)
        };
    }
}
```

### 6.5 容错处理

```csharp
public class ResilientDeduplicationMiddleware
{
    public async Task InvokeAsync(HttpContext context)
    {
        try
        {
            await CheckDeduplicationAsync(context);
        }
        catch (Exception ex)
        {
            // Redis 故障时，记录日志但放行请求
            _logger.LogError(ex, "Deduplication check failed, allowing request");
            
            // 可选：降级为本地缓存
            await FallbackToLocalCache(context);
        }
        
        await _next(context);
    }
}
```

---

## 总结

API 网关层的请求去重是保护后端服务的第一道防线：

### 核心要点

1. **提前拦截**：在入口处阻止重复请求
2. **统一策略**：所有服务共享去重逻辑
3. **灵活配置**：不同 API 使用不同策略
4. **监控告警**：及时发现异常

### 技术选型

- **YARP**：适合 .NET 生态，性能好
- **Kong**：功能丰富，插件生态完善
- **Ocelot**：配置简单，易于上手
- **自定义中间件**：灵活性最高

通过网关层的去重，可以显著降低后端服务的压力，提升系统整体稳定性。
