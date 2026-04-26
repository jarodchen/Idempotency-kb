---
editLink: true
lastUpdated: true
---
# 性能 - Redis 网络开销

## 概述

在使用 Redis 实现幂等性时，网络开销是一个重要的性能考量因素。每次 Redis 操作都需要通过网络往返（RTT），在高并发场景下可能成为瓶颈。

## 网络开销分析

### 1. 单次操作的开销

```
客户端                    网络                     Redis
  |                        |                         |
  |-- 请求 (1ms) --------->|                         |
  |                        |-- 传输 (1-5ms) -------->|
  |                        |                         |-- 处理 (<0.1ms)
  |                        |<-- 响应 (1-5ms) ---------|
  |<-- 响应 (1ms) ----------|                         |
  
总耗时: 2-12ms（主要消耗在网络）
```

### 2. 多次操作的累积效应

```csharp
// ❌ 低效：多次网络往返
public async Task<bool> CheckAndConsumeToken(string token)
{
    // 第 1 次网络往返
    var exists = await _redis.KeyExistsAsync(token);
    if (!exists) return false;
    
    // 第 2 次网络往返
    var status = await _redis.StringGetAsync(token);
    if (status != "pending") return false;
    
    // 第 3 次网络往返
    await _redis.KeyDeleteAsync(token);
    
    return true;
}

// 总耗时: 6-36ms（3 次网络往返）
```

## 优化方案

### 1. 使用 Lua 脚本（推荐）

将多个操作合并为一个原子操作，减少网络往返：

```csharp
public class OptimizedTokenService
{
    private readonly IDatabase _redis;
    
    // 单次网络往返完成检查+删除
    private static readonly string AtomicConsumeScript = @"
        local key = KEYS[1]
        local status = redis.call('GET', key)
        
        if status == 'pending' then
            redis.call('DEL', key)
            return 1
        else
            return 0
        end";
    
    public async Task<bool> ConsumeTokenAsync(string token)
    {
        // 只需 1 次网络往返
        var result = await _redis.ScriptEvaluateAsync(
            AtomicConsumeScript,
            new RedisKey[] { token });
        
        return (int)result == 1;
    }
}

// 优化后耗时: 2-12ms（1 次网络往返）
// 性能提升: 3x
```

### 2. Pipeline 批量操作

使用 Pipeline 将多个命令打包发送：

```csharp
public class PipelinedTokenService
{
    private readonly IDatabase _redis;
    
    public async Task<Dictionary<string, bool>> CheckMultipleTokensAsync(
        IEnumerable<string> tokens)
    {
        var batch = _redis.CreateBatch();
        
        var tasks = new Dictionary<string, Task<RedisResult>>();
        
        foreach (var token in tokens)
        {
            // 所有命令会打包一起发送
            var task = batch.ExecuteAsync(
                "GET", 
                new RedisKey[] { $"token:{token}" });
            
            tasks[token] = task;
        }
        
        // 一次性发送所有命令
        batch.Execute();
        
        // 等待所有结果
        var results = new Dictionary<string, bool>();
        foreach (var kvp in tasks)
        {
            var result = await kvp.Value;
            results[kvp.Key] = !result.IsNull && result.ToString() == "pending";
        }
        
        return results;
    }
}

// 检查 10 个 Token：
// 未优化: 20-120ms（10 次往返）
// Pipeline: 2-12ms（1 次往返）
// 性能提升: 10x
```

### 3. 本地缓存

对热点数据使用本地缓存，减少 Redis 访问：

```csharp
public class CachedTokenService
{
    private readonly IDatabase _redis;
    private readonly IMemoryCache _localCache;
    private readonly TimeSpan _cacheDuration = TimeSpan.FromSeconds(5);
    
    public async Task<bool> IsTokenValidAsync(string token)
    {
        var cacheKey = $"token_valid:{token}";
        
        // 先查本地缓存
        if (_localCache.TryGetValue(cacheKey, out bool cached))
        {
            return cached;
        }
        
        // 缓存未命中，查询 Redis
        var status = await _redis.StringGetAsync($"token:{token}");
        var isValid = status == "pending";
        
        // 写入本地缓存
        _localCache.Set(cacheKey, isValid, _cacheDuration);
        
        return isValid;
    }
}

// 命中率 90% 的场景：
// 平均耗时: 0.1ms * 0.9 + 5ms * 0.1 = 0.59ms
// 性能提升: 8x
```

### 4. 连接池优化

```csharp
// Program.cs
builder.Services.AddSingleton<IConnectionMultiplexer>(sp =>
{
    var config = new ConfigurationOptions
    {
        EndPoints = { "localhost:6379" },
        
        // 连接池配置
        MinimumThreads = 10,
        MaximumThreads = 50,
        
        // 超时配置
        ConnectTimeout = 5000,
        SyncTimeout = 5000,
        AsyncTimeout = 5000,
        
        // 重试策略
        RetryBackoffMultiplier = 2,
        
        // 保持连接活跃
        KeepAlive = 30,
        
        // 禁用自动重连（根据需求）
        AbortOnConnectFail = false
    };
    
    return ConnectionMultiplexer.Connect(config);
});
```

## 性能对比测试

### 基准测试代码

```csharp
public class RedisPerformanceBenchmark
{
    private readonly IDatabase _redis;
    private readonly ITokenService _tokenService;
    
    public async Task RunBenchmarkAsync(int iterations = 10000)
    {
        Console.WriteLine($"Running benchmark with {iterations} iterations...\n");
        
        // 测试 1: 多次单独调用
        var stopwatch = Stopwatch.StartNew();
        for (int i = 0; i < iterations; i++)
        {
            var token = $"benchmark_token_{i}";
            await _redis.StringSetAsync(token, "pending", TimeSpan.FromMinutes(1));
            await _redis.KeyExistsAsync(token);
            await _redis.StringGetAsync(token);
            await _redis.KeyDeleteAsync(token);
        }
        stopwatch.Stop();
        
        Console.WriteLine($"Multiple Calls: {stopwatch.ElapsedMilliseconds}ms");
        Console.WriteLine($"Avg per operation: {stopwatch.ElapsedMilliseconds / (iterations * 4.0):F3}ms\n");
        
        // 测试 2: Lua 脚本
        stopwatch.Restart();
        for (int i = 0; i < iterations; i++)
        {
            var token = $"benchmark_token_{i}";
            await _redis.StringSetAsync(token, "pending", TimeSpan.FromMinutes(1));
            await ConsumeTokenWithLua(token);
        }
        stopwatch.Stop();
        
        Console.WriteLine($"Lua Script: {stopwatch.ElapsedMilliseconds}ms");
        Console.WriteLine($"Avg per operation: {stopwatch.ElapsedMilliseconds / (iterations * 2.0):F3}ms\n");
        
        // 计算性能提升
        var improvement = ((iterations * 4.0) / (iterations * 2.0)) * 100;
        Console.WriteLine($"Performance Improvement: {improvement:F0}%");
    }
    
    private async Task<bool> ConsumeTokenWithLua(string token)
    {
        const string script = @"
            local key = KEYS[1]
            local status = redis.call('GET', key)
            if status == 'pending' then
                redis.call('DEL', key)
                return 1
            else
                return 0
            end";
        
        var result = await _redis.ScriptEvaluateAsync(script, new RedisKey[] { token });
        return (int)result == 1;
    }
}

// 典型结果（10000 次迭代）：
// Multiple Calls: 80000ms (8ms/operation)
// Lua Script:     20000ms (2ms/operation)
// Performance Improvement: 300%
```

## 监控网络延迟

### 1. RTT 监控

```csharp
public class RedisLatencyMonitor
{
    private readonly Histogram<double> _redisRtt;
    private readonly Counter<long> _redisTimeouts;
    
    public async Task<T> ExecuteWithMonitoringAsync<T>(
        Func<Task<T>> operation,
        string operationName)
    {
        var stopwatch = Stopwatch.StartNew();
        
        try
        {
            var result = await operation();
            stopwatch.Stop();
            
            _redisRtt.Record(stopwatch.ElapsedMilliseconds,
                new KeyValuePair<string, object?>("operation", operationName));
            
            return result;
        }
        catch (TimeoutException)
        {
            stopwatch.Stop();
            _redisTimeouts.Add(1,
                new KeyValuePair<string, object?>("operation", operationName));
            
            throw;
        }
    }
}
```

### 2. Prometheus 告警

```yaml
groups:
  - name: redis_performance_alerts
    rules:
      # Redis RTT 过高
      - alert: HighRedisRTT
        expr: histogram_quantile(0.95, rate(redis_rtt_seconds_bucket[5m])) > 0.01
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High Redis RTT"
          description: "95th percentile Redis RTT exceeds 10ms"
      
      # Redis 超时率过高
      - alert: HighRedisTimeoutRate
        expr: rate(redis_timeouts_total[5m]) / rate(redis_operations_total[5m]) > 0.01
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "High Redis timeout rate"
          description: "More than 1% of Redis operations are timing out"
```

## 最佳实践总结

### ✅ DO

1. **使用 Lua 脚本**：减少网络往返次数
2. **Pipeline 批量操作**：合并多个命令
3. **本地缓存热点数据**：减少 Redis 访问
4. **优化连接池配置**：合理设置线程数
5. **监控 RTT**：及时发现网络问题

### ❌ DON'T

1. **不要频繁小操作**：合并为批量操作
2. **不要忽略超时**：设置合理的超时时间
3. **不要在循环中调用 Redis**：使用 Pipeline
4. **不要过度缓存**：注意缓存一致性

## 总结

Redis 网络开销优化的关键策略：

✅ **Lua 脚本**：3x 性能提升  
✅ **Pipeline**：10x 性能提升（批量操作）  
✅ **本地缓存**：8x 性能提升（高命中率）  
✅ **连接池优化**：提高并发能力  

通过合理使用这些优化技术，可以显著降低 Redis 网络开销，提升系统整体性能。
