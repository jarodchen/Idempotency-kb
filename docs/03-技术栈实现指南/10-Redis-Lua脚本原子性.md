---
editLink: true
lastUpdated: true
---
# Redis - Lua 脚本原子性

## 概述

Redis Lua 脚本是实现原子操作的关键技术。通过将多个 Redis 命令封装在一个 Lua 脚本中，可以保证这些命令作为一个整体原子执行，不会被其他命令中断。

## 为什么需要 Lua 脚本

### 问题场景

```
没有 Lua 脚本的情况：

客户端 A                      Redis                     客户端 B
  |                              |                         |
  |-- GET token ---------------->|                         |
  |                              |-- 返回 "pending"         |
  |                              |                         |-- GET token
  |                              |                         |-- 返回 "pending"
  |-- DEL token ---------------->|                         |
  |                              |-- 删除成功                |
  |                              |                         |-- DEL token
  |                              |                         |-- 删除失败
  |                              |                         |
  |-- 创建订单...                 |                         |-- 也创建订单 ❌
```

**问题**：GET 和 DEL 不是原子操作，导致竞态条件。

### 解决方案：Lua 脚本

```lua
-- 原子性地检查并删除 Token
local token = redis.call('GET', KEYS[1])
if token == 'pending' then
    redis.call('DEL', KEYS[1])
    return 1
else
    return 0
end
```

**优势**：整个脚本在 Redis 中原子执行，不会被其他命令打断。

## Lua 脚本基础

### 1. 基本语法

```lua
-- Redis Lua 脚本结构
local result = redis.call('COMMAND', KEYS[1], ARGV[1])
return result

-- KEYS: 键数组（会被 Redis 集群识别）
-- ARGV: 参数数组
```

### 2. 常用命令

```lua
-- 字符串操作
redis.call('SET', KEYS[1], ARGV[1])
redis.call('GET', KEYS[1])
redis.call('DEL', KEYS[1])
redis.call('EXISTS', KEYS[1])

-- 哈希操作
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('HGET', KEYS[1], ARGV[1])
redis.call('HGETALL', KEYS[1])

-- 列表操作
redis.call('LPUSH', KEYS[1], ARGV[1])
redis.call('RPOP', KEYS[1])

-- 集合操作
redis.call('SADD', KEYS[1], ARGV[1])
redis.call('SISMEMBER', KEYS[1], ARGV[1])

-- 有序集合
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZRANGE', KEYS[1], 0, -1)

-- 过期时间
redis.call('EXPIRE', KEYS[1], ARGV[1])
redis.call('TTL', KEYS[1])
```

## C# 中使用 Lua 脚本

### 1. StackExchange.Redis 实现

```csharp
using StackExchange.Redis;

public class RedisLuaScripts
{
    private readonly IDatabase _redis;
    
    public RedisLuaScripts(IConnectionMultiplexer redis)
    {
        _redis = redis.GetDatabase();
    }
    
    /// <summary>
    /// 原子性地获取并删除 Key
    /// </summary>
    public async Task<bool> GetAndDeleteAsync(string key)
    {
        const string script = @"
            local value = redis.call('GET', KEYS[1])
            if value then
                redis.call('DEL', KEYS[1])
                return 1
            else
                return 0
            end";
        
        var result = await _redis.ScriptEvaluateAsync(
            script,
            new RedisKey[] { key });
        
        return (int)result == 1;
    }
    
    /// <summary>
    /// 原子性地设置 Key（仅当不存在时）
    /// </summary>
    public async Task<bool> SetIfNotExistsAsync(string key, string value, TimeSpan expiry)
    {
        const string script = @"
            if redis.call('EXISTS', KEYS[1]) == 0 then
                redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
                return 1
            else
                return 0
            end";
        
        var result = await _redis.ScriptEvaluateAsync(
            script,
            new RedisKey[] { key },
            new RedisValue[] { value, expiry.TotalSeconds });
        
        return (int)result == 1;
    }
    
    /// <summary>
    /// 原子性地递增并检查上限
    /// </summary>
    public async Task<Result<int>> IncrementWithLimitAsync(string key, int limit, TimeSpan expiry)
    {
        const string script = @"
            local current = tonumber(redis.call('GET', KEYS[1]) or '0')
            if current >= tonumber(ARGV[1]) then
                return -1
            end
            local new_value = redis.call('INCR', KEYS[1])
            redis.call('EXPIRE', KEYS[1], ARGV[2])
            return new_value";
        
        var result = await _redis.ScriptEvaluateAsync(
            script,
            new RedisKey[] { key },
            new RedisValue[] { limit, expiry.TotalSeconds });
        
        var newValue = (int)result;
        
        if (newValue == -1)
        {
            return Result<int>.Failure("Limit exceeded");
        }
        
        return Result<int>.Success(newValue);
    }
}
```

### 2. 缓存预加载脚本

```csharp
public class IdempotencyCacheService
{
    private readonly IDatabase _redis;
    
    // Lua 脚本：原子性地检查、存储和返回
    private static readonly string CacheGetOrSetScript = @"
        local key = KEYS[1]
        local value = redis.call('GET', key)
        
        if value then
            -- 缓存命中
            return {1, value}
        else
            -- 缓存未命中，存储新值
            redis.call('SET', key, ARGV[1], 'EX', ARGV[2])
            return {0, ARGV[1]}
        end";
    
    public async Task<(bool isHit, string value)> GetOrSetAsync(
        string key, 
        string value,
        TimeSpan expiry)
    {
        var result = await _redis.ScriptEvaluateAsync(
            CacheGetOrSetScript,
            new RedisKey[] { key },
            new RedisValue[] { value, expiry.TotalSeconds });
        
        var values = (RedisResult[])result;
        
        return (
            isHit: (int)values[0] == 1,
            value: values[1].ToString()
        );
    }
}
```

## 幂等性实战示例

### 1. Token 消耗脚本

```csharp
public class AtomicTokenConsumer
{
    private readonly IDatabase _redis;
    
    // 原子性地消耗 Token
    private static readonly string ConsumeTokenScript = @"
        local key = KEYS[1]
        local status = redis.call('GET', key)
        
        if status == false then
            -- Token 不存在
            return 0
        elseif status == 'processing' then
            -- 正在处理中
            return 2
        elseif status == 'pending' then
            -- 标记为处理中
            redis.call('SET', key, 'processing')
            return 1
        else
            -- 已完成或其他状态
            return 0
        end";
    
    public async Task<TokenStatus> TryConsumeTokenAsync(string tokenKey)
    {
        var result = await _redis.ScriptEvaluateAsync(
            ConsumeTokenScript,
            new RedisKey[] { tokenKey });
        
        return (TokenStatus)(int)result;
    }
}

public enum TokenStatus
{
    NotFound = 0,      // Token 不存在
    Acquired = 1,      // 成功获取
    Processing = 2     // 正在处理中
}
```

### 2. 限流器实现

```csharp
public class RedisRateLimiter
{
    private readonly IDatabase _redis;
    
    // 滑动窗口限流
    private static readonly string RateLimitScript = @"
        local key = KEYS[1]
        local now = tonumber(ARGV[1])
        local window = tonumber(ARGV[2])
        local max_requests = tonumber(ARGV[3])
        
        -- 移除过期的请求记录
        redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
        
        -- 计算当前窗口内的请求数
        local current_count = redis.call('ZCARD', key)
        
        if current_count >= max_requests then
            -- 超过限制
            return 0
        end
        
        -- 添加新的请求记录
        redis.call('ZADD', key, now, now .. ':' .. math.random(1000000))
        redis.call('EXPIRE', key, window)
        
        return 1";
    
    public async Task<bool> AllowRequestAsync(
        string clientId,
        int maxRequests,
        TimeSpan window)
    {
        var key = $"rate_limit:{clientId}";
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        
        var result = await _redis.ScriptEvaluateAsync(
            RateLimitScript,
            new RedisKey[] { key },
            new RedisValue[] { now, window.TotalSeconds, maxRequests });
        
        return (int)result == 1;
    }
}

// 使用示例
public class OrderController
{
    private readonly RedisRateLimiter _rateLimiter;
    
    [HttpPost]
    public async Task<IActionResult> CreateOrder(
        [FromBody] CreateOrderRequest request)
    {
        var userId = User.GetUserId();
        
        // 限流：每个用户每分钟最多 10 个订单
        var allowed = await _rateLimiter.AllowRequestAsync(
            userId.ToString(),
            maxRequests: 10,
            window: TimeSpan.FromMinutes(1));
        
        if (!allowed)
        {
            return StatusCode(429, new { error = "Too many requests" });
        }
        
        // 创建订单逻辑...
    }
}
```

### 3. 分布式计数器

```csharp
public class DistributedCounter
{
    private readonly IDatabase _redis;
    
    // 原子性地增加计数并返回
    private static readonly string IncrementScript = @"
        local key = KEYS[1]
        local increment = tonumber(ARGV[1])
        local ttl = tonumber(ARGV[2])
        
        local new_value = redis.call('INCRBY', key, increment)
        
        -- 设置过期时间（只在第一次创建时）
        if ttl > 0 and new_value == increment then
            redis.call('EXPIRE', key, ttl)
        end
        
        return new_value";
    
    public async Task<long> IncrementAsync(
        string key,
        long increment = 1,
        TimeSpan? ttl = null)
    {
        var result = await _redis.ScriptEvaluateAsync(
            IncrementScript,
            new RedisKey[] { key },
            new RedisValue[] { increment, ttl?.TotalSeconds ?? 0 });
        
        return (long)result;
    }
}
```

## 性能优化

### 1. 脚本缓存

```csharp
public class CachedLuaScripts
{
    private readonly IDatabase _redis;
    private readonly ConcurrentDictionary<string, byte[]> _scriptCache = new();
    
    public async Task<RedisResult> ExecuteCachedScriptAsync(
        string scriptName,
        string script,
        RedisKey[] keys,
        RedisValue[] values)
    {
        // 获取或计算脚本 SHA1
        var sha1 = _scriptCache.GetOrAdd(scriptName, _ =>
        {
            using var sha1Hasher = SHA1.Create();
            var hash = sha1Hasher.ComputeHash(Encoding.UTF8.GetBytes(script));
            return hash;
        });
        
        try
        {
            // 尝试使用 EVALSHA（更快）
            return await _redis.ScriptEvaluateAsync(
                Convert.ToHexString(sha1).ToLowerInvariant(),
                keys,
                values);
        }
        catch (RedisServerException ex) when (ex.Message.Contains("NOSCRIPT"))
        {
            // 脚本不存在，使用 EVAL
            return await _redis.ScriptEvaluateAsync(script, keys, values);
        }
    }
}
```

### 2. 批量操作

```csharp
public class BatchLuaOperations
{
    private readonly IDatabase _redis;
    
    // 批量删除 Keys
    private static readonly string BatchDeleteScript = @"
        local count = 0
        for i, key in ipairs(KEYS) do
            if redis.call('DEL', key) == 1 then
                count = count + 1
            end
        end
        return count";
    
    public async Task<int> BatchDeleteAsync(IEnumerable<string> keys)
    {
        var redisKeys = keys.Select(k => (RedisKey)k).ToArray();
        
        var result = await _redis.ScriptEvaluateAsync(
            BatchDeleteScript,
            redisKeys);
        
        return (int)result;
    }
}
```

## 调试与测试

### 1. 脚本测试

```csharp
public class LuaScriptTests
{
    [Fact]
    public async Task ConsumeToken_ShouldReturnAcquired_WhenTokenIsPending()
    {
        // Arrange
        var redis = ConnectionMultiplexer.Connect("localhost");
        var db = redis.GetDatabase();
        var tokenKey = "test:token:123";
        
        await db.StringSetAsync(tokenKey, "pending");
        
        // Act
        var consumer = new AtomicTokenConsumer(db);
        var status = await consumer.TryConsumeTokenAsync(tokenKey);
        
        // Assert
        Assert.Equal(TokenStatus.Acquired, status);
        
        // Verify token is deleted
        var exists = await db.KeyExistsAsync(tokenKey);
        Assert.False(exists);
    }
    
    [Fact]
    public async Task ConsumeToken_ShouldReturnProcessing_WhenTokenIsProcessing()
    {
        // Arrange
        var redis = ConnectionMultiplexer.Connect("localhost");
        var db = redis.GetDatabase();
        var tokenKey = "test:token:123";
        
        await db.StringSetAsync(tokenKey, "processing");
        
        // Act
        var consumer = new AtomicTokenConsumer(db);
        var status = await consumer.TryConsumeTokenAsync(tokenKey);
        
        // Assert
        Assert.Equal(TokenStatus.Processing, status);
    }
}
```

### 2. Redis CLI 调试

```bash
# 在 Redis CLI 中测试脚本
redis-cli

# 加载脚本
EVAL "return redis.call('GET', KEYS[1])" 1 mykey

# 查看已加载的脚本
SCRIPT EXISTS sha1_hash

# 清除所有脚本缓存
SCRIPT FLUSH
```

## 最佳实践总结

### ✅ DO

1. **保持脚本简洁**：避免复杂逻辑，减少执行时间
2. **使用 KEYS 数组**：让 Redis 集群能正确识别键
3. **缓存脚本 SHA1**：提高重复执行性能
4. **错误处理**：捕获 NOSCRIPT 异常
5. **测试充分**：单元测试 + 集成测试

### ❌ DON'T

1. **不要执行长时间运行的脚本**：会阻塞 Redis
2. **不要使用随机数生成**：会导致主从不一致
3. **不要访问外部资源**：Lua 脚本只能使用 Redis 命令
4. **不要忽略返回值**：始终检查脚本执行结果

## 总结

Redis Lua 脚本是实现原子操作的强大工具：

✅ **原子性**：脚本中的所有命令原子执行  
✅ **高性能**：减少网络往返，脚本缓存  
✅ **灵活性**：支持复杂的业务逻辑  
✅ **可靠性**：避免竞态条件  

在幂等性系统中，Lua 脚本是保证 Token 操作原子性的最佳方案。
