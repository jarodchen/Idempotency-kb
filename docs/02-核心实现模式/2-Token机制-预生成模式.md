---
editLink: true
lastUpdated: true
---
# Token 机制 - 预生成 Token 模式

## 概述

预生成 Token 模式是实现幂等性的经典方案之一。其核心思想是：**客户端在发起请求前先获取一个唯一的 Token，服务端通过验证 Token 的唯一性来保证操作的幂等性**。

## 工作流程

```
客户端                          服务端                         Redis/数据库
  |                               |                               |
  |--- 1. 请求 Token ------------>|                               |
  |                               |--- 2. 生成 Token ------------>|
  |                               |<-- 3. 返回 Token -------------|
  |<-- 4. 返回 Token (UUID) ------|                               |
  |                               |                               |
  |--- 5. 携带 Token 发起请求 ---->|                               |
  |                               |--- 6. 检查 Token 是否存在 ---->|
  |                               |<-- 7a. Token 不存在 -----------|
  |                               |--- 8. 执行业务逻辑             |
  |                               |--- 9. 标记 Token 已使用 ------>|
  |<-- 10. 返回结果 --------------|                               |
  |                               |                               |
  |--- 11. 重试（相同 Token) ---->|                               |
  |                               |--- 12. 检查 Token 是否存在 --->|
  |                               |<-- 13b. Token 已存在 ----------|
  |<-- 14. 返回缓存结果 ----------|                               |
```

## 核心优势

1. **强一致性**：通过原子操作保证 Token 的唯一性
2. **可扩展性**：支持分布式环境下的幂等性控制
3. **可追溯性**：每个请求都有唯一的标识
4. **灵活性**：可以设置 Token 过期时间

## 实现方案

### 方案 1：基于 Redis 的实现（推荐）

#### 1.1 Token 服务接口

```csharp
public interface IIdempotencyTokenService
{
    /// <summary>
    /// 生成新的幂等 Token
    /// </summary>
    Task<string> GenerateTokenAsync(TimeSpan? expiry = null);
    
    /// <summary>
    /// 尝试获取并锁定 Token（原子操作）
    /// </summary>
    /// <returns>如果成功获取返回 true，否则返回 false</returns>
    Task<bool> TryAcquireTokenAsync(string token, TimeSpan expiry);
    
    /// <summary>
    /// 存储请求结果
    /// </summary>
    Task StoreResultAsync(string token, object result, TimeSpan expiry);
    
    /// <summary>
    /// 获取已存储的结果
    /// </summary>
    Task<T> GetResultAsync<T>(string token);
}
```

#### 1.2 Redis 实现

```csharp
using StackExchange.Redis;
using System.Text.Json;

public class RedisIdempotencyTokenService : IIdempotencyTokenService
{
    private readonly IDatabase _redis;
    private readonly ILogger<RedisIdempotencyTokenService> _logger;
    private const string TokenPrefix = "idempotency:token:";
    private const string ResultPrefix = "idempotency:result:";
    
    public RedisIdempotencyTokenService(
        IConnectionMultiplexer redis,
        ILogger<RedisIdempotencyTokenService> logger)
    {
        _redis = redis.GetDatabase();
        _logger = logger;
    }
    
    public async Task<string> GenerateTokenAsync(TimeSpan? expiry = null)
    {
        var token = Guid.NewGuid().ToString("N");
        var ttl = expiry ?? TimeSpan.FromMinutes(30);
        
        // Token 默认 30 分钟过期
        await _redis.StringSetAsync(
            $"{TokenPrefix}{token}", 
            "pending", 
            ttl,
            When.NotExists);
        
        _logger.LogDebug("生成幂等 Token: {Token}, 有效期: {TTL}", token, ttl);
        
        return token;
    }
    
    public async Task<bool> TryAcquireTokenAsync(string token, TimeSpan expiry)
    {
        var key = $"{TokenPrefix}{token}";
        
        // 使用 SET NX EX 实现原子操作
        // 只有当 key 不存在时才能设置成功
        var acquired = await _redis.StringSetAsync(
            key, 
            "processing", 
            expiry,
            When.NotExists);
        
        if (acquired)
        {
            _logger.LogDebug("成功获取 Token: {Token}", token);
        }
        else
        {
            _logger.LogWarning("Token 已被使用: {Token}", token);
        }
        
        return acquired;
    }
    
    public async Task StoreResultAsync(string token, object result, TimeSpan expiry)
    {
        var resultKey = $"{ResultPrefix}{token}";
        var serializedResult = JsonSerializer.Serialize(result);
        
        await _redis.StringSetAsync(resultKey, serializedResult, expiry);
        
        // 更新 Token 状态为 completed
        var tokenKey = $"{TokenPrefix}{token}";
        await _redis.StringSetAsync(tokenKey, "completed", expiry);
        
        _logger.LogDebug("存储 Token 结果: {Token}", token);
    }
    
    public async Task<T> GetResultAsync<T>(string token)
    {
        var resultKey = $"{ResultPrefix}{token}";
        var serializedResult = await _redis.StringGetAsync(resultKey);
        
        if (serializedResult.IsNullOrEmpty)
        {
            return default;
        }
        
        return JsonSerializer.Deserialize<T>(serializedResult!);
    }
}
```

#### 1.3 ASP.NET Core 中间件

```csharp
public class IdempotencyMiddleware
{
    private readonly RequestDelegate _next;
    private readonly IIdempotencyTokenService _tokenService;
    private readonly ILogger<IdempotencyMiddleware> _logger;
    private const string IdempotencyKeyHeader = "Idempotency-Key";
    private const string IdempotencyTokenHeader = "Idempotency-Token";
    
    public IdempotencyMiddleware(
        RequestDelegate next,
        IIdempotencyTokenService tokenService,
        ILogger<IdempotencyMiddleware> logger)
    {
        _next = next;
        _tokenService = tokenService;
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
        
        // 从请求头获取 Token
        var token = context.Request.Headers[IdempotencyKeyHeader].FirstOrDefault()
                    ?? context.Request.Headers[IdempotencyTokenHeader].FirstOrDefault();
        
        if (string.IsNullOrEmpty(token))
        {
            // 如果没有 Token，继续处理（或者可以要求必须提供）
            await _next(context);
            return;
        }
        
        // 尝试获取 Token 锁
        var acquired = await _tokenService.TryAcquireTokenAsync(token, TimeSpan.FromMinutes(30));
        
        if (!acquired)
        {
            // Token 已被使用，返回缓存的结果
            await ReturnCachedResult(context, token);
            return;
        }
        
        // 替换响应流以捕获响应内容
        var originalBodyStream = context.Response.Body;
        using var responseBody = new MemoryStream();
        context.Response.Body = responseBody;
        
        try
        {
            // 继续处理请求
            await _next(context);
            
            // 读取响应内容
            responseBody.Seek(0, SeekOrigin.Begin);
            var responseContent = await new StreamReader(responseBody).ReadToEndAsync();
            
            // 如果响应成功，存储结果
            if (context.Response.StatusCode >= 200 && context.Response.StatusCode < 300)
            {
                await _tokenService.StoreResultAsync(
                    token, 
                    new 
                    { 
                        StatusCode = context.Response.StatusCode,
                        ContentType = context.Response.ContentType,
                        Body = responseContent 
                    },
                    TimeSpan.FromHours(24));
            }
            
            // 将响应写回原始流
            responseBody.Seek(0, SeekOrigin.Begin);
            await responseBody.CopyToAsync(originalBodyStream);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "处理幂等请求时发生错误: {Token}", token);
            
            // 发生异常时，删除 Token 以便可以重试
            // 实际生产中应该有更复杂的逻辑
            
            throw;
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
    
    private async Task ReturnCachedResult(HttpContext context, string token)
    {
        var cachedResult = await _tokenService.GetResultAsync<dynamic>(token);
        
        if (cachedResult == null)
        {
            // Token 存在但结果尚未存储（请求正在处理中）
            context.Response.StatusCode = StatusCodes.Status409Conflict;
            await context.Response.WriteAsJsonAsync(new 
            { 
                error = "Request is being processed",
                message = "A request with this idempotency key is currently being processed"
            });
            return;
        }
        
        // 返回缓存的结果
        context.Response.StatusCode = cachedResult.StatusCode;
        context.Response.ContentType = cachedResult.ContentType;
        await context.Response.WriteAsync(cachedResult.Body);
        
        _logger.LogInformation("返回缓存的幂等结果: {Token}", token);
    }
}
```

#### 1.4 注册中间件和服务

```csharp
// Program.cs
var builder = WebApplication.CreateBuilder(args);

// 添加 Redis 连接
builder.Services.AddSingleton<IConnectionMultiplexer>(sp =>
{
    var configuration = ConfigurationOptions.Parse(
        builder.Configuration["Redis:ConnectionString"]);
    return ConnectionMultiplexer.Connect(configuration);
});

// 添加幂等性服务
builder.Services.AddScoped<IIdempotencyTokenService, RedisIdempotencyTokenService>();

var app = builder.Build();

// 注册中间件（在路由之前）
app.UseMiddleware<IdempotencyMiddleware>();

app.MapControllers();
app.Run();
```

### 方案 2：基于 PostgreSQL 的实现

#### 2.1 数据库表设计

```sql
-- 幂等 Token 表
CREATE TABLE idempotency_tokens (
    token VARCHAR(64) PRIMARY KEY,
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending, processing, completed
    request_method VARCHAR(10),
    request_path TEXT,
    request_body TEXT,
    response_status INTEGER,
    response_headers JSONB,
    response_body TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

-- 索引
CREATE INDEX idx_idempotency_tokens_expires_at ON idempotency_tokens(expires_at);
CREATE INDEX idx_idempotency_tokens_status ON idempotency_tokens(status);

-- 自动清理过期 Token 的函数
CREATE OR REPLACE FUNCTION cleanup_expired_tokens()
RETURNS void AS $$
BEGIN
    DELETE FROM idempotency_tokens 
    WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;
```

#### 2.2 PostgreSQL 实现

```csharp
using Npgsql;

public class PostgreSqlIdempotencyTokenService : IIdempotencyTokenService
{
    private readonly string _connectionString;
    private readonly ILogger<PostgreSqlIdempotencyTokenService> _logger;
    
    public PostgreSqlIdempotencyTokenService(
        IConfiguration configuration,
        ILogger<PostgreSqlIdempotencyTokenService> logger)
    {
        _connectionString = configuration.GetConnectionString("DefaultConnection");
        _logger = logger;
    }
    
    public async Task<string> GenerateTokenAsync(TimeSpan? expiry = null)
    {
        var token = Guid.NewGuid().ToString("N");
        var ttl = expiry ?? TimeSpan.FromMinutes(30);
        var expiresAt = DateTime.UtcNow.Add(ttl);
        
        await using var connection = new NpgsqlConnection(_connectionString);
        await connection.OpenAsync();
        
        const string sql = @"
            INSERT INTO idempotency_tokens (token, status, expires_at)
            VALUES (@token, 'pending', @expiresAt)
            ON CONFLICT (token) DO NOTHING";
        
        await using var command = new NpgsqlCommand(sql, connection);
        command.Parameters.AddWithValue("@token", token);
        command.Parameters.AddWithValue("@expiresAt", expiresAt);
        
        await command.ExecuteNonQueryAsync();
        
        _logger.LogDebug("生成幂等 Token: {Token}", token);
        
        return token;
    }
    
    public async Task<bool> TryAcquireTokenAsync(string token, TimeSpan expiry)
    {
        await using var connection = new NpgsqlConnection(_connectionString);
        await connection.OpenAsync();
        
        const string sql = @"
            UPDATE idempotency_tokens
            SET status = 'processing',
                updated_at = NOW(),
                expires_at = @expiresAt
            WHERE token = @token
              AND status = 'pending'
              AND expires_at > NOW()
            RETURNING token";
        
        await using var command = new NpgsqlCommand(sql, connection);
        command.Parameters.AddWithValue("@token", token);
        command.Parameters.AddWithValue("@expiresAt", DateTime.UtcNow.Add(expiry));
        
        var result = await command.ExecuteScalarAsync();
        
        var acquired = result != null;
        
        if (acquired)
        {
            _logger.LogDebug("成功获取 Token: {Token}", token);
        }
        else
        {
            _logger.LogWarning("Token 已被使用或已过期: {Token}", token);
        }
        
        return acquired;
    }
    
    public async Task StoreResultAsync(string token, object result, TimeSpan expiry)
    {
        await using var connection = new NpgsqlConnection(_connectionString);
        await connection.OpenAsync();
        
        const string sql = @"
            UPDATE idempotency_tokens
            SET status = 'completed',
                response_status = @responseStatus,
                response_headers = @responseHeaders,
                response_body = @responseBody,
                updated_at = NOW(),
                expires_at = @expiresAt
            WHERE token = @token";
        
        await using var command = new NpgsqlCommand(sql, connection);
        command.Parameters.AddWithValue("@token", token);
        command.Parameters.AddWithValue("@responseStatus", ((dynamic)result).StatusCode);
        command.Parameters.AddWithValue("@responseHeaders", 
            JsonSerializer.Serialize(((dynamic)result).ContentType));
        command.Parameters.AddWithValue("@responseBody", ((dynamic)result).Body);
        command.Parameters.AddWithValue("@expiresAt", DateTime.UtcNow.Add(expiry));
        
        await command.ExecuteNonQueryAsync();
        
        _logger.LogDebug("存储 Token 结果: {Token}", token);
    }
    
    public async Task<T> GetResultAsync<T>(string token)
    {
        await using var connection = new NpgsqlConnection(_connectionString);
        await connection.OpenAsync();
        
        const string sql = @"
            SELECT response_status, response_headers, response_body
            FROM idempotency_tokens
            WHERE token = @token
              AND status = 'completed'
              AND expires_at > NOW()";
        
        await using var command = new NpgsqlCommand(sql, connection);
        command.Parameters.AddWithValue("@token", token);
        
        await using var reader = await command.ExecuteReaderAsync();
        
        if (!await reader.ReadAsync())
        {
            return default;
        }
        
        var statusCode = reader.GetInt32(0);
        var contentType = reader.GetString(1);
        var body = reader.GetString(2);
        
        // 这里需要根据实际需求反序列化
        return (T)(object)new 
        { 
            StatusCode = statusCode,
            ContentType = contentType,
            Body = body 
        };
    }
}
```

## 客户端使用示例

### 生成和使用 Token

```csharp
public class OrderService
{
    private readonly HttpClient _httpClient;
    private readonly IIdempotencyTokenService _tokenService;
    
    public OrderService(
        HttpClient httpClient,
        IIdempotencyTokenService tokenService)
    {
        _httpClient = httpClient;
        _tokenService = tokenService;
    }
    
    public async Task<Order> CreateOrderWithToken(CreateOrderRequest request)
    {
        // 1. 生成 Token
        var token = await _tokenService.GenerateTokenAsync(TimeSpan.FromMinutes(30));
        
        // 2. 在请求头中携带 Token
        var httpRequest = new HttpRequestMessage(HttpMethod.Post, "/api/orders");
        httpRequest.Headers.Add("Idempotency-Key", token);
        httpRequest.Content = JsonContent.Create(request);
        
        // 3. 发送请求
        var response = await _httpClient.SendAsync(httpRequest);
        response.EnsureSuccessStatusCode();
        
        // 4. 解析响应
        return await response.Content.ReadFromJsonAsync<Order>();
    }
}
```

### JavaScript 客户端示例

```javascript
class OrderService {
  async createOrder(orderData) {
    // 生成唯一 Token
    const idempotencyKey = crypto.randomUUID();
    
    // 发送请求
    const response = await fetch('/api/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify(orderData)
    });
    
    if (!response.ok) {
      throw new Error('Failed to create order');
    }
    
    return await response.json();
  }
  
  // 带重试的订单创建
  async createOrderWithRetry(orderData, maxRetries = 3) {
    const idempotencyKey = crypto.randomUUID();
    
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await fetch('/api/orders', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey
          },
          body: JSON.stringify(orderData)
        });
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        
        return await response.json();
      } catch (error) {
        if (i === maxRetries - 1) {
          throw error; // 最后一次重试失败，抛出异常
        }
        
        // 等待后重试（指数退避）
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000));
      }
    }
  }
}
```

## 最佳实践

### 1. Token 过期时间设置

```csharp
// 根据业务场景设置不同的过期时间
public class TokenExpirySettings
{
    // 快速操作：5 分钟
    public static TimeSpan QuickOperation => TimeSpan.FromMinutes(5);
    
    // 普通操作：30 分钟
    public static TimeSpan NormalOperation => TimeSpan.FromMinutes(30);
    
    // 长时间操作：24 小时
    public static TimeSpan LongOperation => TimeSpan.FromHours(24);
}

// 使用示例
var token = await _tokenService.GenerateTokenAsync(
    TokenExpirySettings.LongOperation);
```

### 2. Token 格式设计

```csharp
public class TokenGenerator
{
    /// <summary>
    /// 生成包含业务信息的 Token
    /// 格式: {prefix}_{timestamp}_{random}
    /// 示例: order_1234567890_abcdef123456
    /// </summary>
    public static string GenerateBusinessToken(string businessType)
    {
        var timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var random = Guid.NewGuid().ToString("N")[..12];
        
        return $"{businessType}_{timestamp}_{random}";
    }
}

// 使用
var token = TokenGenerator.GenerateBusinessToken("order");
// 输出: order_1712345678_abc123def456
```

### 3. 监控和日志

```csharp
public class IdempotencyMetrics
{
    private readonly Counter<int> _tokenGeneratedCount;
    private readonly Counter<int> _tokenAcquiredCount;
    private readonly Counter<int> _tokenDuplicateCount;
    private readonly Histogram<double> _tokenProcessingTime;
    
    public IdempotencyMetrics(IMeterFactory meterFactory)
    {
        var meter = meterFactory.Create("Idempotency");
        
        _tokenGeneratedCount = meter.CreateCounter<int>(
            "tokens.generated", 
            description: "Number of idempotency tokens generated");
        
        _tokenAcquiredCount = meter.CreateCounter<int>(
            "tokens.acquired", 
            description: "Number of tokens successfully acquired");
        
        _tokenDuplicateCount = meter.CreateCounter<int>(
            "tokens.duplicates", 
            description: "Number of duplicate token requests");
        
        _tokenProcessingTime = meter.CreateHistogram<double>(
            "tokens.processing.time", 
            unit: "ms",
            description: "Time spent processing idempotent requests");
    }
    
    public void RecordTokenGenerated() => _tokenGeneratedCount.Add(1);
    public void RecordTokenAcquired() => _tokenAcquiredCount.Add(1);
    public void RecordTokenDuplicate() => _tokenDuplicateCount.Add(1);
    public void RecordProcessingTime(double milliseconds) => 
        _tokenProcessingTime.Record(milliseconds);
}
```

## 常见问题

### Q1: Token 冲突怎么办？

**答**：使用 UUID/GUID 作为 Token 可以几乎完全避免冲突。如果仍然担心冲突，可以在数据库层面使用 `ON CONFLICT` 或 Redis 的 `SET NX` 来保证原子性。

### Q2: Token 被劫持怎么办？

**答**：
1. 使用 HTTPS 传输
2. Token 一次性使用，使用后立即失效
3. 设置合理的过期时间
4. 可以绑定 Token 到用户会话

### Q3: 如何清理过期的 Token？

```sql
-- 定期清理任务（每天执行）
DELETE FROM idempotency_tokens
WHERE expires_at < NOW() - INTERVAL '7 days';
```

```csharp
// Redis 会自动过期，无需手动清理
// 但可以定期统计
var keys = _redis.Keys($"{TokenPrefix}*");
var count = keys.Count();
_logger.LogInformation("当前活跃的 Token 数量: {Count}", count);
```

## 总结

预生成 Token 模式是实现幂等性的强大工具，特别适合以下场景：

✅ **分布式系统**：支持多节点共享状态  
✅ **高并发场景**：通过 Redis 实现高性能原子操作  
✅ **需要审计追踪**：每个请求都有唯一标识  
✅ **复杂业务流程**：可以关联业务上下文  

但也需要注意：

⚠️ **额外复杂度**：需要管理 Token 的生命周期  
⚠️ **存储成本**：需要额外的存储空间  
⚠️ **网络开销**：每次请求都需要额外的 Redis/DB 调用  

在实际应用中，建议根据业务需求选择合适的实现方案，并做好监控和告警机制。
