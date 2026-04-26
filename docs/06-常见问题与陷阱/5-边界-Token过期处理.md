---
editLink: true
lastUpdated: true
---
# 边界 - Token 过期处理

## 概述

Token 过期是幂等性系统中的常见边界情况。如果处理不当，会导致：
1. **合法请求被拒绝**：Token 意外过期
2. **安全风险**：Token 永不过期
3. **用户体验差**：频繁要求重新获取 Token

## Token 生命周期

```
Token 状态机:

Created → Pending → Processing → Completed
    ↓         ↓           ↓
 Expired  Expired     Expired
```

## 过期时间策略

### 1. 根据业务场景设置

```csharp
public static class TokenExpiryPolicies
{
    /// <summary>
    /// 快速操作：5 分钟
    /// 适用于：表单提交、简单查询
    /// </summary>
    public static TimeSpan QuickOperation => TimeSpan.FromMinutes(5);
    
    /// <summary>
    /// 普通操作：30 分钟
    /// 适用于：订单创建、用户注册
    /// </summary>
    public static TimeSpan NormalOperation => TimeSpan.FromMinutes(30);
    
    /// <summary>
    /// 长时间操作：24 小时
    /// 适用于：文件上传、批量导入
    /// </summary>
    public static TimeSpan LongOperation => TimeSpan.FromHours(24);
    
    /// <summary>
    /// 超长操作：7 天
    /// 适用于：异步任务、后台处理
    /// </summary>
    public static TimeSpan VeryLongOperation => TimeSpan.FromDays(7);
}
```

### 2. 动态过期时间

```csharp
public class DynamicTokenExpiryService
{
    /// <summary>
    /// 根据请求复杂度动态计算过期时间
    /// </summary>
    public TimeSpan CalculateExpiry(CreateOrderRequest request)
    {
        // 基础时间
        var baseExpiry = TimeSpan.FromMinutes(30);
        
        // 根据订单项数量增加时间
        var itemCount = request.Items?.Count ?? 0;
        var itemBonus = TimeSpan.FromSeconds(itemCount * 10);
        
        // 根据总金额增加时间（大额订单可能需要更多验证）
        var totalAmount = request.Items?.Sum(i => i.Quantity * i.UnitPrice) ?? 0;
        var amountBonus = totalAmount > 10000 
            ? TimeSpan.FromMinutes(15) 
            : TimeSpan.Zero;
        
        return baseExpiry + itemBonus + amountBonus;
    }
}
```

## 过期检测与处理

### 1. Redis 实现

```csharp
public class TokenExpiryHandler
{
    private readonly IDatabase _redis;
    private readonly ILogger<TokenExpiryHandler> _logger;
    
    public async Task<Result<string>> ValidateTokenAsync(string tokenKey)
    {
        // 检查 Token 是否存在
        var status = await _redis.StringGetAsync(tokenKey);
        
        if (status.IsNullOrEmpty)
        {
            // Token 不存在或已过期
            _logger.LogWarning("Token expired or not found: {Key}", tokenKey);
            return Result<string>.Failure("Token expired, please request a new one");
        }
        
        // 检查 TTL
        var ttl = await _redis.KeyTimeToLiveAsync(tokenKey);
        
        if (ttl.HasValue && ttl.Value.TotalSeconds < 0)
        {
            _logger.LogWarning("Token TTL is negative: {Key}, TTL: {TTL}", tokenKey, ttl);
            return Result<string>.Failure("Token expired");
        }
        
        // 返回当前状态
        return Result<string>.Success(status);
    }
    
    public async Task<bool> ExtendTokenExpiryAsync(string tokenKey, TimeSpan additionalTime)
    {
        var currentTtl = await _redis.KeyTimeToLiveAsync(tokenKey);
        
        if (!currentTtl.HasValue || currentTtl.Value <= TimeSpan.Zero)
        {
            // Token 已过期，无法续期
            return false;
        }
        
        // 延长过期时间
        var newExpiry = currentTtl.Value + additionalTime;
        
        // Redis 不支持直接延长，需要重新设置
        var value = await _redis.StringGetAsync(tokenKey);
        await _redis.StringSetAsync(tokenKey, value, newExpiry);
        
        _logger.LogInformation("Extended token expiry: {Key}, New TTL: {TTL}", 
            tokenKey, newExpiry);
        
        return true;
    }
}
```

### 2. PostgreSQL 实现

```sql
-- 查询即将过期的 Token
SELECT 
    token,
    status,
    expires_at,
    NOW() as current_time,
    expires_at - NOW() as time_remaining
FROM idempotency_tokens
WHERE expires_at > NOW()
  AND expires_at < NOW() + INTERVAL '5 minutes'
ORDER BY expires_at ASC;

-- 清理过期 Token
DELETE FROM idempotency_tokens
WHERE expires_at < NOW() - INTERVAL '7 days';

-- 更新过期时间
UPDATE idempotency_tokens
SET expires_at = NOW() + INTERVAL '30 minutes'
WHERE token = $1
  AND status = 'pending'
  AND expires_at > NOW();
```

```csharp
public class DatabaseTokenExpiryHandler
{
    private readonly AppDbContext _dbContext;
    
    public async Task<Result<TokenStatus>> ValidateTokenAsync(string token)
    {
        var tokenRecord = await _dbContext.IdempotencyTokens
            .FirstOrDefaultAsync(t => t.Token == token);
        
        if (tokenRecord == null)
        {
            return Result<TokenStatus>.Failure("Token not found");
        }
        
        if (tokenRecord.ExpiresAt < DateTime.UtcNow)
        {
            return Result<TokenStatus>.Failure("Token expired");
        }
        
        return Result<TokenStatus>.Success(new TokenStatus
        {
            Status = tokenRecord.Status,
            RemainingTime = tokenRecord.ExpiresAt - DateTime.UtcNow
        });
    }
    
    public async Task CleanupExpiredTokensAsync(int retentionDays = 7)
    {
        var cutoffDate = DateTime.UtcNow.AddDays(-retentionDays);
        
        var deletedCount = await _dbContext.IdempotencyTokens
            .Where(t => t.ExpiresAt < cutoffDate)
            .ExecuteDeleteAsync();
        
        _logger.LogInformation("Cleaned up {Count} expired tokens", deletedCount);
    }
}
```

## 客户端重试策略

### 1. 检测 Token 过期并重试

```csharp
public class ResilientApiClient
{
    private readonly HttpClient _httpClient;
    private readonly ITokenService _tokenService;
    
    public async Task<Order> CreateOrderWithRetry(
        CreateOrderRequest request,
        int maxRetries = 2)
    {
        string idempotencyKey = null;
        
        for (int attempt = 0; attempt <= maxRetries; attempt++)
        {
            try
            {
                // 第一次尝试使用现有 Key，重试时生成新 Key
                if (idempotencyKey == null)
                {
                    idempotencyKey = await _tokenService.GetOrCreateTokenAsync();
                }
                
                var httpRequest = new HttpRequestMessage(HttpMethod.Post, "/api/orders");
                httpRequest.Headers.Add("Idempotency-Key", idempotencyKey);
                httpRequest.Content = JsonContent.Create(request);
                
                var response = await _httpClient.SendAsync(httpRequest);
                
                if (response.StatusCode == HttpStatusCode.Gone) // 410 Gone
                {
                    // Token 已过期，获取新 Token 后重试
                    _logger.LogInformation("Token expired, getting new token and retrying");
                    idempotencyKey = null; // 清除旧 Key
                    
                    if (attempt < maxRetries)
                    {
                        continue;
                    }
                }
                
                response.EnsureSuccessStatusCode();
                return await response.Content.ReadFromJsonAsync<Order>();
            }
            catch (HttpRequestException ex) when (ex.StatusCode == HttpStatusCode.RequestTimeout)
            {
                _logger.LogWarning(ex, "Request timeout on attempt {Attempt}", attempt + 1);
                
                if (attempt == maxRetries)
                {
                    throw;
                }
                
                // 指数退避
                await Task.Delay(TimeSpan.FromSeconds(Math.Pow(2, attempt)));
            }
        }
        
        throw new Exception("Failed after retries");
    }
}
```

### 2. 前端 Token 刷新

```typescript
class TokenManager {
  private token: string | null = null;
  private tokenExpiry: number | null = null;
  
  async getToken(): Promise<string> {
    // 检查 Token 是否即将过期（提前 1 分钟刷新）
    if (this.token && this.tokenExpiry) {
      const timeRemaining = this.tokenExpiry - Date.now();
      
      if (timeRemaining > 60000) {
        // Token 仍然有效
        return this.token;
      }
    }
    
    // Token 过期或即将过期，获取新 Token
    return await this.refreshToken();
  }
  
  private async refreshToken(): Promise<string> {
    const response = await fetch('/api/tokens', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getAuthToken()}`
      }
    });
    
    if (!response.ok) {
      throw new Error('Failed to refresh token');
    }
    
    const data = await response.json();
    
    this.token = data.token;
    this.tokenExpiry = Date.now() + (data.expiresIn * 1000);
    
    return this.token;
  }
  
  async submitWithToken(data: any): Promise<any> {
    let retryCount = 0;
    const maxRetries = 2;
    
    while (retryCount <= maxRetries) {
      try {
        const token = await this.getToken();
        
        const response = await fetch('/api/orders', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': token
          },
          body: JSON.stringify(data)
        });
        
        if (response.status === 410) {
          // Token 过期，刷新后重试
          this.token = null;
          retryCount++;
          continue;
        }
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        
        return await response.json();
      } catch (error) {
        if (retryCount === maxRetries) {
          throw error;
        }
        retryCount++;
      }
    }
    
    throw new Error('Failed after retries');
  }
}
```

## 监控与告警

### 1. 指标收集

```csharp
public class TokenExpiryMetrics
{
    private readonly Counter<long> _expiredTokens;
    private readonly Counter<long> _extendedTokens;
    private readonly Histogram<double> _tokenLifetime;
    private readonly Gauge<int> _activeTokens;
    
    public void RecordTokenExpired(string reason)
    {
        _expiredTokens.Add(1, 
            new KeyValuePair<string, object?>("reason", reason));
    }
    
    public void RecordTokenExtended()
    {
        _extendedTokens.Add(1);
    }
    
    public void RecordTokenLifetime(double lifetimeSeconds)
    {
        _tokenLifetime.Record(lifetimeSeconds);
    }
    
    public void UpdateActiveTokenCount(int count)
    {
        _activeTokens.Set(count);
    }
}
```

### 2. Prometheus 告警

```yaml
groups:
  - name: token_expiry_alerts
    rules:
      # Token 过期率过高
      - alert: HighTokenExpiryRate
        expr: rate(token_expired_total[5m]) / rate(token_created_total[5m]) > 0.3
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High token expiry rate"
          description: "More than 30% of tokens are expiring before use"
      
      # 活跃 Token 数量异常
      - alert: AbnormalActiveTokenCount
        expr: token_active_count > 10000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Abnormal active token count"
          description: "More than 10000 active tokens"
      
      # Token 平均寿命过短
      - alert: ShortTokenLifetime
        expr: histogram_quantile(0.5, rate(token_lifetime_seconds_bucket[5m])) < 60
        for: 10m
        labels:
          severity: info
        annotations:
          summary: "Short token lifetime"
          description: "Median token lifetime is less than 60 seconds"
```

## 最佳实践总结

### ✅ DO

1. **设置合理的过期时间**：根据业务场景调整
2. **提前刷新 Token**：在过期前 1 分钟刷新
3. **实现自动重试**：Token 过期后自动获取新 Token
4. **定期清理**：删除过期的 Token 记录
5. **监控指标**：跟踪 Token 过期率和生命周期

### ❌ DON'T

1. **不要设置过短的过期时间**：导致频繁刷新
2. **不要设置过长的过期时间**：增加安全风险
3. **不要忽略过期检测**：可能导致安全漏洞
4. **不要忘记清理旧数据**：避免存储膨胀

## 总结

Token 过期处理是幂等性系统的重要边界情况：

✅ **合理策略**：根据业务场景设置过期时间  
✅ **自动刷新**：客户端提前刷新 Token  
✅ **优雅重试**：Token 过期后自动重试  
✅ **监控清理**：定期清理过期 Token  

通过完善的过期处理机制，可以平衡安全性和用户体验。
