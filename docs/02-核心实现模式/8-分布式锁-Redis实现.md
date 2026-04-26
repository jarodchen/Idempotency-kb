---
editLink: true
lastUpdated: true
---
# 分布式锁 - Redis实现

## 概述

分布式锁用于在多个服务实例之间协调对共享资源的访问。Redis 是实现分布式锁的最常用方案，因为它性能高、支持原子操作。

## 核心原理

```
客户端 A                    Redis                      客户端 B
  |                           |                           |
  |-- SET lock_key value NX EX 30 ->|                           |
  |                           |-- 设置成功（返回 OK）       |
  |                           |                           |-- SET lock_key value NX EX 30
  |                           |                           |-- 设置失败（返回 nil）
  |                           |                           |
  |-- 执行业务逻辑...          |                           |-- 等待或重试
  |                           |                           |
  |-- DEL lock_key ---------->|                           |
  |                           |-- 删除成功                  |
  |                           |                           |-- SET lock_key value NX EX 30
  |                           |                           |-- 设置成功，获取锁
```

## RedLock 算法

Redis 官方推荐的分布式锁算法（Martin Kleppmann 提出）：

1. **获取当前时间**（毫秒）
2. **依次尝试在 N 个 Redis 实例上获取锁**
3. **计算获取锁的总耗时**
4. **只有在大多数节点上都成功，且总耗时小于锁有效期，才认为成功**
5. **释放锁时，需要在所有节点上删除**

## C# 实现

### 1. 基础实现

```csharp
using StackExchange.Redis;

public interface IDistributedLock
{
    Task<bool> AcquireAsync(string key, TimeSpan expiry);
    Task ReleaseAsync(string key);
    Task<T> ExecuteWithLockAsync<T>(string key, Func<Task<T>> action, TimeSpan? expiry = null);
}

public class RedisDistributedLock : IDistributedLock
{
    private readonly IDatabase _redis;
    private readonly ILogger<RedisDistributedLock> _logger;
    
    public RedisDistributedLock(
        IConnectionMultiplexer redis,
        ILogger<RedisDistributedLock> logger)
    {
        _redis = redis.GetDatabase();
        _logger = logger;
    }
    
    public async Task<bool> AcquireAsync(string key, TimeSpan expiry)
    {
        var lockValue = Guid.NewGuid().ToString("N");
        
        // SET key value NX EX seconds - 原子操作
        var acquired = await _redis.StringSetAsync(
            key,
            lockValue,
            expiry,
            When.NotExists);
        
        if (acquired)
        {
            _logger.LogDebug("Lock acquired: {Key}", key);
        }
        else
        {
            _logger.LogDebug("Lock not acquired: {Key}", key);
        }
        
        return acquired;
    }
    
    public async Task ReleaseAsync(string key)
    {
        // 直接删除（生产环境应该使用 Lua 脚本保证安全性）
        await _redis.KeyDeleteAsync(key);
        
        _logger.LogDebug("Lock released: {Key}", key);
    }
    
    public async Task<T> ExecuteWithLockAsync<T>(
        string key, 
        Func<Task<T>> action,
        TimeSpan? expiry = null)
    {
        var lockExpiry = expiry ?? TimeSpan.FromSeconds(30);
        var lockAcquired = false;
        
        try
        {
            // 尝试获取锁
            lockAcquired = await AcquireAsync(key, lockExpiry);
            
            if (!lockAcquired)
            {
                throw new TimeoutException($"Failed to acquire lock: {key}");
            }
            
            // 执行受保护的操作
            return await action();
        }
        finally
        {
            // 确保释放锁
            if (lockAcquired)
            {
                try
                {
                    await ReleaseAsync(key);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Failed to release lock: {Key}", key);
                }
            }
        }
    }
}
```

### 2. 安全的锁释放（Lua 脚本）

```csharp
public class SafeRedisDistributedLock : IDistributedLock
{
    private readonly IDatabase _redis;
    
    // Lua 脚本：只有持有者才能释放锁
    private static readonly string ReleaseLockScript = @"
        if redis.call('get', KEYS[1]) == ARGV[1] then
            return redis.call('del', KEYS[1])
        else
            return 0
        end";
    
    public async Task<bool> AcquireAsync(string key, TimeSpan expiry)
    {
        var lockValue = $"{Environment.MachineName}:{Guid.NewGuid():N}";
        
        var acquired = await _redis.StringSetAsync(
            key,
            lockValue,
            expiry,
            When.NotExists);
        
        return acquired;
    }
    
    public async Task ReleaseAsync(string key)
    {
        // 使用 Lua 脚本安全释放
        var result = await _redis.ScriptEvaluateAsync(
            ReleaseLockScript,
            new RedisKey[] { key },
            new RedisValue[] { GetLockValue(key) });
        
        if ((int)result == 0)
        {
            _logger.LogWarning("Failed to release lock (may be held by another process): {Key}", key);
        }
    }
    
    private string GetLockValue(string key)
    {
        // 实际生产中应该在获取锁时保存 lockValue
        // 这里简化处理
        return "";
    }
}
```

### 3. 带重试的锁获取

```csharp
public class RetryableDistributedLock : IDistributedLock
{
    private readonly IDatabase _redis;
    private readonly int _maxRetries;
    private readonly TimeSpan _retryDelay;
    
    public RetryableDistributedLock(
        IConnectionMultiplexer redis,
        int maxRetries = 10,
        TimeSpan? retryDelay = null)
    {
        _redis = redis.GetDatabase();
        _maxRetries = maxRetries;
        _retryDelay = retryDelay ?? TimeSpan.FromMilliseconds(100);
    }
    
    public async Task<bool> AcquireAsync(string key, TimeSpan expiry)
    {
        for (int i = 0; i < _maxRetries; i++)
        {
            var lockValue = Guid.NewGuid().ToString("N");
            
            var acquired = await _redis.StringSetAsync(
                key,
                lockValue,
                expiry,
                When.NotExists);
            
            if (acquired)
            {
                return true;
            }
            
            // 等待后重试
            if (i < _maxRetries - 1)
            {
                await Task.Delay(_retryDelay);
            }
        }
        
        return false;
    }
    
    public async Task ReleaseAsync(string key)
    {
        await _redis.KeyDeleteAsync(key);
    }
}
```

## 实际应用示例

### 1. 防止重复下单

```csharp
public class OrderServiceWithLock
{
    private readonly IDistributedLock _lock;
    private readonly AppDbContext _dbContext;
    
    public async Task<Order> CreateOrderAsync(Guid userId, CreateOrderRequest request)
    {
        var lockKey = $"order_lock:{userId}";
        
        // 使用分布式锁保证同一用户不会并发创建订单
        return await _lock.ExecuteWithLockAsync(lockKey, async () =>
        {
            // 检查是否有未支付的订单
            var existingOrder = await _dbContext.Orders
                .FirstOrDefaultAsync(o => 
                    o.UserId == userId && 
                    o.Status == "pending");
            
            if (existingOrder != null)
            {
                throw new InvalidOperationException("You have a pending order");
            }
            
            // 创建新订单
            var order = new Order
            {
                Id = Guid.NewGuid(),
                UserId = userId,
                TotalAmount = request.TotalAmount,
                Status = "pending",
                CreatedAt = DateTime.UtcNow
            };
            
            _dbContext.Orders.Add(order);
            await _dbContext.SaveChangesAsync();
            
            return order;
        }, TimeSpan.FromSeconds(10));
    }
}
```

### 2. 库存扣减

```csharp
public class InventoryServiceWithLock
{
    private readonly IDistributedLock _lock;
    private readonly AppDbContext _dbContext;
    
    public async Task<Result<bool>> DeductStockAsync(
        Guid productId, 
        int quantity)
    {
        var lockKey = $"inventory_lock:{productId}";
        
        try
        {
            return await _lock.ExecuteWithLockAsync(lockKey, async () =>
            {
                var product = await _dbContext.Products.FindAsync(productId);
                
                if (product == null)
                {
                    return Result<bool>.Failure("Product not found");
                }
                
                if (product.Stock < quantity)
                {
                    return Result<bool>.Failure("Insufficient stock");
                }
                
                product.Stock -= quantity;
                await _dbContext.SaveChangesAsync();
                
                return Result<bool>.Success(true);
            }, TimeSpan.FromSeconds(5));
        }
        catch (TimeoutException)
        {
            return Result<bool>.Failure("System busy, please try again later");
        }
    }
}
```

### 3. 定时任务防重复执行

```csharp
public class ScheduledTaskService
{
    private readonly IDistributedLock _lock;
    private readonly ILogger<ScheduledTaskService> _logger;
    
    public async Task ExecuteDailyReportAsync()
    {
        var lockKey = "scheduled_task:daily_report";
        var lockExpiry = TimeSpan.FromMinutes(30); // 任务最长执行 30 分钟
        
        var acquired = await _lock.AcquireAsync(lockKey, lockExpiry);
        
        if (!acquired)
        {
            _logger.LogInformation("Daily report task is already running, skipping");
            return;
        }
        
        try
        {
            _logger.LogInformation("Starting daily report generation");
            
            // 执行报表生成逻辑
            await GenerateDailyReportAsync();
            
            _logger.LogInformation("Daily report generation completed");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to generate daily report");
            throw;
        }
        finally
        {
            await _lock.ReleaseAsync(lockKey);
        }
    }
}
```

## RedLock.net 库（推荐）

### 1. 安装

```bash
dotnet add package RedLock.net
```

### 2. 使用

```csharp
using RedLockNet;
using RedLockNet.SERedis;
using RedLockNet.SERedis.Configuration;

public class RedLockService
{
    private readonly IRedLockFactory _redLockFactory;
    
    public RedLockService(IConnectionMultiplexer redis)
    {
        var redLockEndpoints = new List<RedLockEndPoint>
        {
            new DnsEndPoint("redis1.example.com", 6379),
            new DnsEndPoint("redis2.example.com", 6379),
            new DnsEndPoint("redis3.example.com", 6379)
        };
        
        _redLockFactory = RedLockFactory.CreateFromMultiplexer(redis, redLockEndpoints);
    }
    
    public async Task<T> ExecuteWithRedLockAsync<T>(
        string resource,
        Func<Task<T>> action,
        TimeSpan? expiry = null)
    {
        var lockExpiry = expiry ?? TimeSpan.FromSeconds(30);
        
        await using (var redLock = await _redLockFactory.CreateLockAsync(
            resource,
            lockExpiry,
            waitTime: TimeSpan.FromSeconds(10), // 等待获取锁的时间
            retryTime: TimeSpan.FromMilliseconds(200))) // 重试间隔
        {
            if (redLock.IsAcquired)
            {
                // 成功获取锁，执行业务逻辑
                return await action();
            }
            else
            {
                throw new TimeoutException($"Could not acquire lock for {resource}");
            }
        }
    }
}

// 注册服务
builder.Services.AddSingleton<IRedLockFactory>(sp =>
{
    var redis = sp.GetRequiredService<IConnectionMultiplexer>();
    return RedLockFactory.CreateFromMultiplexer(redis, new List<RedLockEndPoint>
    {
        new DnsEndPoint("redis1", 6379),
        new DnsEndPoint("redis2", 6379),
        new DnsEndPoint("redis3", 6379)
    });
});
```

## 监控与告警

### 1. 指标收集

```csharp
public class DistributedLockMetrics
{
    private readonly Counter<long> _lockAttempts;
    private readonly Counter<long> _lockSuccesses;
    private readonly Counter<long> _lockFailures;
    private readonly Histogram<double> _lockWaitTime;
    private readonly Histogram<double> _lockHoldTime;
    
    public void RecordLockAttempt(bool success, double waitTimeMs, double holdTimeMs)
    {
        _lockAttempts.Add(1);
        
        if (success)
        {
            _lockSuccesses.Add(1);
        }
        else
        {
            _lockFailures.Add(1);
        }
        
        _lockWaitTime.Record(waitTimeMs);
        _lockHoldTime.Record(holdTimeMs);
    }
}
```

### 2. Prometheus 告警

```yaml
groups:
  - name: distributed_lock_alerts
    rules:
      - alert: HighLockContention
        expr: rate(distributed_lock_failures_total[5m]) / rate(distributed_lock_attempts_total[5m]) > 0.2
        for: 5m
        annotations:
          summary: "High distributed lock contention"
          description: "More than 20% of lock attempts are failing"
      
      - alert: LongLockHoldTime
        expr: histogram_quantile(0.99, distributed_lock_hold_time_seconds) > 30
        for: 5m
        annotations:
          summary: "Long lock hold time"
          description: "99th percentile lock hold time exceeds 30 seconds"
```

## 最佳实践总结

### ✅ DO

1. **设置合理的过期时间**：避免死锁
2. **使用唯一标识**：确保只有持有者能释放锁
3. **实现重试机制**：提高成功率
4. **监控锁竞争**：及时发现性能问题
5. **使用 RedLock**：多节点部署时使用官方算法

### ❌ DON'T

1. **不要长时间持有锁**：尽快释放
2. **不要忘记释放锁**：使用 try-finally
3. **不要用锁替代幂等性**：两者结合使用
4. **不要忽略超时**：设置合理的等待时间

## 总结

Redis 分布式锁是处理分布式并发的有效工具：

✅ **优点**：
- 高性能
- 实现简单
- 支持自动过期

⚠️ **注意事项**：
- 需要处理锁超时
- 单点故障风险（使用 RedLock）
- 不能替代幂等性设计

在实际应用中，分布式锁应与幂等性机制结合使用，形成完整的并发控制体系。
