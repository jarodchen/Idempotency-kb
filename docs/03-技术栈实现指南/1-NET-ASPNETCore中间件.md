---
editLink: true
lastUpdated: true
---
# ASP.NET Core 中间件实现幂等性

## 概述

在 ASP.NET Core 中，通过中间件（Middleware）实现幂等性是一种优雅且可复用的方案。中间件可以在请求管道的早期拦截请求，检查幂等性，避免重复处理。

## 架构设计

```
HTTP Request
    ↓
[Idempotency Middleware] ← 检查幂等键
    ↓ (新请求)
[Authentication Middleware]
    ↓
[Authorization Middleware]  
    ↓
[Endpoint Middleware]
    ↓
Response
    ↓
[Idempotency Middleware] ← 缓存响应结果
```

## 完整实现

### 1. 配置类

```csharp
public class IdempotencyOptions
{
    /// <summary>
    /// 请求头名称
    /// </summary>
    public string HeaderName { get; set; } = "Idempotency-Key";
    
    /// <summary>
    /// 默认过期时间
    /// </summary>
    public TimeSpan DefaultExpiry { get; set; } = TimeSpan.FromHours(24);
    
    /// <summary>
    /// 仅对这些 HTTP 方法启用幂等性检查
    /// </summary>
    public HashSet<string> EnabledMethods { get; set; } = new()
    {
        HttpMethods.Post,
        HttpMethods.Put,
        HttpMethods.Patch
    };
    
    /// <summary>
    /// 排除的路径（不进行幂等性检查）
    /// </summary>
    public HashSet<string> ExcludedPaths { get; set; } = new();
    
    /// <summary>
    /// 最大请求体大小（字节）
    /// </summary>
    public long MaxRequestBodySize { get; set; } = 10 * 1024 * 1024; // 10MB
}
```

### 2. 幂等性存储服务接口

```csharp
public interface IIdempotencyStore
{
    /// <summary>
    /// 尝试获取锁
    /// </summary>
    Task<bool> TryAcquireLockAsync(string key, TimeSpan expiry);
    
    /// <summary>
    /// 存储响应
    /// </summary>
    Task StoreResponseAsync(string key, IdempotencyResponse response, TimeSpan expiry);
    
    /// <summary>
    /// 获取已存储的响应
    /// </summary>
    Task<IdempotencyResponse?> GetResponseAsync(string key);
}

public class IdempotencyResponse
{
    public int StatusCode { get; set; }
    public Dictionary<string, string> Headers { get; set; } = new();
    public byte[] Body { get; set; } = Array.Empty<byte>();
}
```

### 3. Redis 存储实现

```csharp
using StackExchange.Redis;
using System.Text.Json;

public class RedisIdempotencyStore : IIdempotencyStore
{
    private readonly IDatabase _redis;
    private const string LockPrefix = "idempotency:lock:";
    private const string ResponsePrefix = "idempotency:response:";
    
    public RedisIdempotencyStore(IConnectionMultiplexer redis)
    {
        _redis = redis.GetDatabase();
    }
    
    public async Task<bool> TryAcquireLockAsync(string key, TimeSpan expiry)
    {
        var lockKey = $"{LockPrefix}{key}";
        
        // SET NX EX - 只有在 key 不存在时才设置
        return await _redis.StringSetAsync(
            lockKey,
            "1",
            expiry,
            When.NotExists);
    }
    
    public async Task StoreResponseAsync(string key, IdempotencyResponse response, TimeSpan expiry)
    {
        var responseKey = $"{ResponsePrefix}{key}";
        var json = JsonSerializer.Serialize(response);
        
        await _redis.StringSetAsync(responseKey, json, expiry);
    }
    
    public async Task<IdempotencyResponse?> GetResponseAsync(string key)
    {
        var responseKey = $"{ResponsePrefix}{key}";
        var json = await _redis.StringGetAsync(responseKey);
        
        if (json.IsNullOrEmpty)
        {
            return null;
        }
        
        return JsonSerializer.Deserialize<IdempotencyResponse>(json!);
    }
}
```

### 4. 中间件实现

```csharp
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Options;
using System.Diagnostics;
using System.IO.Compression;

public class IdempotencyMiddleware
{
    private readonly RequestDelegate _next;
    private readonly IIdempotencyStore _store;
    private readonly IdempotencyOptions _options;
    private readonly ILogger<IdempotencyMiddleware> _logger;
    
    public IdempotencyMiddleware(
        RequestDelegate next,
        IIdempotencyStore store,
        IOptions<IdempotencyOptions> options,
        ILogger<IdempotencyMiddleware> logger)
    {
        _next = next;
        _store = store;
        _options = options.Value;
        _logger = logger;
    }
    
    public async Task InvokeAsync(HttpContext context)
    {
        // 检查是否需要跳过幂等性检查
        if (!ShouldCheckIdempotency(context))
        {
            await _next(context);
            return;
        }
        
        // 获取幂等键
        var idempotencyKey = context.Request.Headers[_options.HeaderName].FirstOrDefault();
        
        if (string.IsNullOrWhiteSpace(idempotencyKey))
        {
            // 如果没有提供幂等键，可以选择拒绝或继续
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            await context.Response.WriteAsJsonAsync(new
            {
                error = "Missing required header",
                message = $"Header '{_options.HeaderName}' is required for {_options.EnabledMethods.Count} requests"
            });
            return;
        }
        
        // 验证幂等键格式
        if (!IsValidIdempotencyKey(idempotencyKey))
        {
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            await context.Response.WriteAsJsonAsync(new
            {
                error = "Invalid idempotency key",
                message = "Idempotency key must be a valid UUID or non-empty string"
            });
            return;
        }
        
        // 尝试获取锁
        var acquired = await _store.TryAcquireLockAsync(idempotencyKey, _options.DefaultExpiry);
        
        if (!acquired)
        {
            // 锁已被占用，返回缓存的响应或冲突错误
            await ReturnCachedOrConflictResponse(context, idempotencyKey);
            return;
        }
        
        // 捕获响应
        var originalBodyStream = context.Response.Body;
        using var responseBodyStream = new MemoryStream();
        context.Response.Body = responseBodyStream;
        
        var stopwatch = Stopwatch.StartNew();
        
        try
        {
            // 继续处理请求
            await _next(context);
            
            stopwatch.Stop();
            
            // 读取响应
            responseBodyStream.Seek(0, SeekOrigin.Begin);
            var responseBytes = await ReadAllBytesAsync(responseBodyStream);
            
            // 如果响应成功，缓存结果
            if (IsSuccessStatusCode(context.Response.StatusCode))
            {
                var response = new IdempotencyResponse
                {
                    StatusCode = context.Response.StatusCode,
                    Body = responseBytes
                };
                
                // 复制响应头
                foreach (var header in context.Response.Headers)
                {
                    if (!header.Key.StartsWith(":", StringComparison.Ordinal))
                    {
                        response.Headers[header.Key] = header.Value.ToString();
                    }
                }
                
                await _store.StoreResponseAsync(idempotencyKey, response, _options.DefaultExpiry);
                
                _logger.LogInformation(
                    "Cached idempotent response for key: {Key}, status: {Status}, time: {Ms}ms",
                    idempotencyKey,
                    context.Response.StatusCode,
                    stopwatch.ElapsedMilliseconds);
            }
            
            // 将响应写入原始流
            responseBodyStream.Seek(0, SeekOrigin.Begin);
            await responseBodyStream.CopyToAsync(originalBodyStream);
        }
        catch (Exception ex)
        {
            stopwatch.Stop();
            
            _logger.LogError(ex,
                "Error processing request with idempotency key: {Key}, time: {Ms}ms",
                idempotencyKey,
                stopwatch.ElapsedMilliseconds);
            
            // 发生异常时，删除锁以便重试
            // 注意：生产环境可能需要更复杂的策略
            
            throw;
        }
        finally
        {
            context.Response.Body = originalBodyStream;
        }
    }
    
    private bool ShouldCheckIdempotency(HttpContext context)
    {
        // 检查 HTTP 方法
        if (!_options.EnabledMethods.Contains(context.Request.Method, StringComparer.OrdinalIgnoreCase))
        {
            return false;
        }
        
        // 检查排除的路径
        var path = context.Request.Path.Value?.ToLowerInvariant();
        if (path != null && _options.ExcludedPaths.Any(p => path.StartsWith(p)))
        {
            return false;
        }
        
        return true;
    }
    
    private bool IsValidIdempotencyKey(string key)
    {
        // 可以是 UUID 或任意非空字符串
        return !string.IsNullOrWhiteSpace(key) && key.Length <= 128;
    }
    
    private async Task ReturnCachedOrConflictResponse(HttpContext context, string key)
    {
        var cachedResponse = await _store.GetResponseAsync(key);
        
        if (cachedResponse != null)
        {
            // 返回缓存的响应
            context.Response.StatusCode = cachedResponse.StatusCode;
            
            foreach (var header in cachedResponse.Headers)
            {
                context.Response.Headers[header.Key] = header.Value;
            }
            
            // 添加标识头
            context.Response.Headers["X-Idempotency-Cached"] = "true";
            
            await context.Response.Body.WriteAsync(cachedResponse.Body, 0, cachedResponse.Body.Length);
            
            _logger.LogDebug("Returned cached response for key: {Key}", key);
        }
        else
        {
            // 请求正在处理中
            context.Response.StatusCode = StatusCodes.Status409Conflict;
            await context.Response.WriteAsJsonAsync(new
            {
                error = "Request in progress",
                message = "A request with this idempotency key is currently being processed"
            });
        }
    }
    
    private bool IsSuccessStatusCode(int statusCode)
    {
        return statusCode >= 200 && statusCode < 300;
    }
    
    private static async Task<byte[]> ReadAllBytesAsync(Stream stream)
    {
        using var memoryStream = new MemoryStream();
        await stream.CopyToAsync(memoryStream);
        return memoryStream.ToArray();
    }
}
```

### 5. 扩展方法

```csharp
public static class IdempotencyMiddlewareExtensions
{
    public static IServiceCollection AddIdempotency(this IServiceCollection services,
        Action<IdempotencyOptions>? configureOptions = null)
    {
        services.Configure(configureOptions ?? (_ => { }));
        services.AddSingleton<IIdempotencyStore, RedisIdempotencyStore>();
        
        return services;
    }
    
    public static IApplicationBuilder UseIdempotency(this IApplicationBuilder app)
    {
        return app.UseMiddleware<IdempotencyMiddleware>();
    }
}
```

### 6. 注册和使用

```csharp
// Program.cs
var builder = WebApplication.CreateBuilder(args);

// 添加 Redis
builder.Services.AddSingleton<IConnectionMultiplexer>(sp =>
{
    var config = ConfigurationOptions.Parse(
        builder.Configuration["Redis:ConnectionString"]);
    return ConnectionMultiplexer.Connect(config);
});

// 添加幂等性支持
builder.Services.AddIdempotency(options =>
{
    options.HeaderName = "Idempotency-Key";
    options.DefaultExpiry = TimeSpan.FromHours(24);
    options.EnabledMethods = new HashSet<string>
    {
        HttpMethods.Post,
        HttpMethods.Put,
        HttpMethods.Patch
    };
    options.ExcludedPaths = new HashSet<string>
    {
        "/api/webhooks", // webhook 可能有自己的幂等机制
        "/health" // 健康检查不需要
    };
});

// 添加控制器
builder.Services.AddControllers();

var app = builder.Build();

// 使用中间件（在认证授权之后，路由之前）
app.UseAuthentication();
app.UseAuthorization();
app.UseIdempotency();

app.MapControllers();
app.Run();
```

## 控制器示例

### 订单创建

```csharp
[ApiController]
[Route("api/[controller]")]
public class OrdersController : ControllerBase
{
    private readonly OrderService _orderService;
    
    public OrdersController(OrderService orderService)
    {
        _orderService = orderService;
    }
    
    [HttpPost]
    [ProducesResponseType(typeof(Order), StatusCodes.Status201Created)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<Order>> CreateOrder([FromBody] CreateOrderRequest request)
    {
        // 中间件已经保证了幂等性
        // 这里只需要处理业务逻辑
        
        var order = await _orderService.CreateOrderAsync(request);
        
        return CreatedAtAction(
            nameof(GetOrder), 
            new { id = order.Id }, 
            order);
    }
    
    [HttpGet("{id}")]
    public async Task<ActionResult<Order>> GetOrder(Guid id)
    {
        var order = await _orderService.GetOrderAsync(id);
        return Ok(order);
    }
}
```

### 支付处理

```csharp
[ApiController]
[Route("api/[controller]")]
public class PaymentsController : ControllerBase
{
    private readonly PaymentService _paymentService;
    
    [HttpPost("process")]
    public async Task<ActionResult<PaymentResult>> ProcessPayment(
        [FromBody] ProcessPaymentRequest request)
    {
        // 幂等性由中间件保证
        // 相同的 Idempotency-Key 只会处理一次
        
        var result = await _paymentService.ProcessPaymentAsync(request);
        
        return Ok(result);
    }
}
```

## 客户端使用

### C# 客户端

```csharp
public class ApiClient
{
    private readonly HttpClient _httpClient;
    
    public ApiClient(HttpClient httpClient)
    {
        _httpClient = httpClient;
    }
    
    public async Task<Order> CreateOrderAsync(CreateOrderRequest request)
    {
        // 生成幂等键
        var idempotencyKey = Guid.NewGuid().ToString();
        
        var httpRequest = new HttpRequestMessage(HttpMethod.Post, "/api/orders");
        httpRequest.Headers.Add("Idempotency-Key", idempotencyKey);
        httpRequest.Content = JsonContent.Create(request);
        
        var response = await _httpClient.SendAsync(httpRequest);
        response.EnsureSuccessStatusCode();
        
        return await response.Content.ReadFromJsonAsync<Order>();
    }
    
    // 带重试的实现
    public async Task<Order> CreateOrderWithRetryAsync(
        CreateOrderRequest request, 
        int maxRetries = 3)
    {
        // 使用相同的幂等键进行重试
        var idempotencyKey = Guid.NewGuid().ToString();
        
        for (int i = 0; i < maxRetries; i++)
        {
            try
            {
                var httpRequest = new HttpRequestMessage(HttpMethod.Post, "/api/orders");
                httpRequest.Headers.Add("Idempotency-Key", idempotencyKey);
                httpRequest.Content = JsonContent.Create(request);
                
                var response = await _httpClient.SendAsync(httpRequest);
                response.EnsureSuccessStatusCode();
                
                return await response.Content.ReadFromJsonAsync<Order>();
            }
            catch (HttpRequestException ex) when (i < maxRetries - 1)
            {
                // 指数退避
                await Task.Delay(TimeSpan.FromSeconds(Math.Pow(2, i)));
            }
        }
        
        throw new Exception("Failed to create order after retries");
    }
}
```

### JavaScript 客户端

```javascript
class ApiClient {
  constructor(baseURL) {
    this.baseURL = baseURL;
  }
  
  async createOrder(orderData) {
    // 生成唯一幂等键
    const idempotencyKey = crypto.randomUUID();
    
    const response = await fetch(`${this.baseURL}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify(orderData)
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    
    return await response.json();
  }
  
  // 带重试的实现
  async createOrderWithRetry(orderData, maxRetries = 3) {
    const idempotencyKey = crypto.randomUUID();
    
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await this.createOrderWithKey(orderData, idempotencyKey);
      } catch (error) {
        if (i === maxRetries - 1) {
          throw error;
        }
        
        // 指数退避
        await new Promise(resolve => 
          setTimeout(resolve, Math.pow(2, i) * 1000));
      }
    }
  }
  
  async createOrderWithKey(orderData, idempotencyKey) {
    const response = await fetch(`${this.baseURL}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify(orderData)
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    
    return await response.json();
  }
}
```

## 监控和指标

```csharp
public class IdempotencyMetrics
{
    private readonly Counter<long> _requestsTotal;
    private readonly Counter<long> _cacheHits;
    private readonly Counter<long> _cacheMisses;
    private readonly Histogram<double> _processingTime;
    
    public IdempotencyMetrics(IMeterFactory meterFactory)
    {
        var meter = meterFactory.Create("Idempotency");
        
        _requestsTotal = meter.CreateCounter<long>(
            "requests.total",
            description: "Total number of idempotent requests");
        
        _cacheHits = meter.CreateCounter<long>(
            "cache.hits",
            description: "Number of cache hits");
        
        _cacheMisses = meter.CreateCounter<long>(
            "cache.misses",
            description: "Number of cache misses");
        
        _processingTime = meter.CreateHistogram<double>(
            "processing.time",
            unit: "ms",
            description: "Request processing time");
    }
    
    public void RecordRequest(bool isCacheHit, double processingTimeMs)
    {
        _requestsTotal.Add(1);
        
        if (isCacheHit)
        {
            _cacheHits.Add(1);
        }
        else
        {
            _cacheMisses.Add(1);
        }
        
        _processingTime.Record(processingTimeMs);
    }
}
```

## 最佳实践

### 1. 选择合适的存储

- **Redis**：高性能，适合高并发场景
- **PostgreSQL**：持久化好，适合需要审计的场景
- **内存**：仅用于开发测试

### 2. 设置合理的过期时间

```csharp
// 根据业务场景设置不同的过期时间
options.DefaultExpiry = TimeSpan.FromHours(24); // 一般操作
options.DefaultExpiry = TimeSpan.FromMinutes(5); // 快速操作
options.DefaultExpiry = TimeSpan.FromDays(7); // 长时间操作
```

### 3. 监控告警

```csharp
// 监控缓存命中率
var hitRate = cacheHits / (cacheHits + cacheMisses);

if (hitRate < 0.5)
{
    // 缓存命中率过低，可能存在问题
    _logger.LogWarning("Low cache hit rate: {Rate}", hitRate);
}
```

## 总结

ASP.NET Core 中间件实现幂等性的优势：

✅ **透明性**：对控制器代码无侵入  
✅ **可复用**：一次实现，全局生效  
✅ **灵活性**：可以配置排除路径、HTTP 方法等  
✅ **高性能**：基于 Redis 实现高速缓存  

注意事项：

⚠️ 确保中间件注册顺序正确  
⚠️ 合理设置过期时间，避免内存泄漏  
⚠️ 做好监控和告警  
⚠️ 考虑异常情况的处理策略
