---
editLink: true
lastUpdated: true
---
# 一致性 - Token删除原子性

## 概述

在基于 Token 的幂等性实现中，**删除 Token 与执行业务逻辑的原子性**是一个关键问题。如果处理不当，可能导致：

1. **Token 提前删除**：业务逻辑失败，但 Token 已删除，重试时会创建重复数据
2. **Token 未删除**：业务逻辑成功，但 Token 未删除，导致无法重试
3. **竞态条件**：多个请求同时检查 Token，都通过验证

## 问题分析

### 场景 1：非原子操作导致的问题

```csharp
// ❌ 错误示例：非原子操作
public async Task<Order> CreateOrder(CreateOrderRequest request, string token)
{
    // 1. 检查 Token
    var tokenExists = await _redis.KeyExistsAsync(token);
    if (!tokenExists)
    {
        throw new InvalidOperationException("Token already used");
    }
    
    // 2. 删除 Token（此时如果崩溃，Token 已删除但订单未创建）
    await _redis.KeyDeleteAsync(token);
    
    // 3. 创建订单（如果这里失败，Token 已被删除）
    var order = await _orderService.CreateAsync(request);
    
    return order;
}

// 问题时间线：
// T1: 请求A检查 Token -> 存在
// T2: 请求A删除 Token -> 成功
// T3: 请求A创建订单 -> 失败（数据库异常）
// T4: 用户重试，请求B检查 Token -> 不存在（被T2删除）
// T5: 请求B被拒绝 -> 用户无法重试 ❌
```

### 场景 2：竞态条件

```
请求 A                      Redis                     请求 B
  |                           |                         |
  |-- EXISTS token ---------->|                         |
  |                           |-- 返回 1 (存在)          |
  |                           |                         |-- EXISTS token
  |                           |                         |-- 返回 1 (存在)
  |-- DEL token ------------->|                         |
  |                           |-- 删除成功                |
  |                           |                         |-- DEL token
  |                           |                         |-- 删除失败（已不存在）
  |                           |                         |
  |-- 创建订单...              |                         |-- 也被允许创建订单 ❌
```

## 解决方案

### 方案 1：Lua 脚本保证原子性（推荐）

```csharp
public class AtomicTokenService
{
    private readonly IDatabase _redis;
    
    // Lua 脚本：原子性地检查并删除 Token
    private static readonly string CheckAndDeleteScript = @"
        local token = redis.call('GET', KEYS[1])
        if token then
            redis.call('DEL', KEYS[1])
            return token
        else
            return nil
        end";
    
    public async Task<bool> TryConsumeTokenAsync(string tokenKey)
    {
        var result = await _redis.ScriptEvaluateAsync(
            CheckAndDeleteScript,
            new RedisKey[] { tokenKey });
        
        return !result.IsNull;
    }
}

// 使用示例
public class OrderServiceWithAtomicToken
{
    private readonly AtomicTokenService _tokenService;
    
    public async Task<Order> CreateOrderAsync(
        CreateOrderRequest request, 
        string token)
    {
        // 原子性地消耗 Token
        var consumed = await _tokenService.TryConsumeTokenAsync(token);
        
        if (!consumed)
        {
            throw new InvalidOperationException("Token already used or expired");
        }
        
        // Token 已成功删除，现在可以安全地创建订单
        var order = await _orderService.CreateAsync(request);
        
        return order;
    }
}
```

**优势**：
- ✅ 检查和删除是原子操作
- ✅ 避免竞态条件
- ✅ 高性能（单次 Redis 往返）

### 方案 2：事务 + 状态标记

```csharp
public class TransactionalTokenService
{
    private readonly IDatabase _redis;
    
    public async Task<Result<T>> ExecuteWithTokenAsync<T>(
        string tokenKey,
        Func<Task<T>> action,
        TimeSpan tokenExpiry)
    {
        // 使用 SET NX 获取锁
        var lockValue = Guid.NewGuid().ToString("N");
        var acquired = await _redis.StringSetAsync(
            tokenKey,
            lockValue,
            tokenExpiry,
            When.NotExists);
        
        if (!acquired)
        {
            return Result<T>.Failure("Token already consumed");
        }
        
        try
        {
            // 执行业务逻辑
            var result = await action();
            
            // 成功后删除 Token
            await _redis.KeyDeleteAsync(tokenKey);
            
            return Result<T>.Success(result);
        }
        catch (Exception ex)
        {
            // 失败时不删除 Token，允许重试
            // 但要确保只有持有者能删除
            await SafeDeleteTokenAsync(tokenKey, lockValue);
            
            throw;
        }
    }
    
    private async Task SafeDeleteTokenAsync(string key, string expectedValue)
    {
        var luaScript = @"
            if redis.call('get', KEYS[1]) == ARGV[1] then
                return redis.call('del', KEYS[1])
            else
                return 0
            end";
        
        await _redis.ScriptEvaluateAsync(luaScript,
            new RedisKey[] { key },
            new RedisValue[] { expectedValue });
    }
}
```

### 方案 3：两阶段提交

```csharp
public class TwoPhaseTokenService
{
    private readonly IDatabase _redis;
    
    /// <summary>
    /// 第一阶段：预留 Token（标记为 processing）
    /// </summary>
    public async Task<bool> ReserveTokenAsync(string tokenKey, TimeSpan expiry)
    {
        var luaScript = @"
            local status = redis.call('GET', KEYS[1])
            if status == 'pending' then
                redis.call('SET', KEYS[1], 'processing', 'EX', ARGV[1])
                return 1
            else
                return 0
            end";
        
        var result = await _redis.ScriptEvaluateAsync(luaScript,
            new RedisKey[] { tokenKey },
            new RedisValue[] { expiry.TotalSeconds });
        
        return (int)result == 1;
    }
    
    /// <summary>
    /// 第二阶段a：确认完成（删除 Token）
    /// </summary>
    public async Task ConfirmTokenAsync(string tokenKey)
    {
        var luaScript = @"
            if redis.call('get', KEYS[1]) == 'processing' then
                redis.call('del', KEYS[1])
                return 1
            else
                return 0
            end";
        
        await _redis.ScriptEvaluateAsync(luaScript,
            new RedisKey[] { tokenKey });
    }
    
    /// <summary>
    /// 第二阶段b：回滚（恢复为 pending）
    /// </summary>
    public async Task RollbackTokenAsync(string tokenKey, TimeSpan expiry)
    {
        var luaScript = @"
            if redis.call('get', KEYS[1]) == 'processing' then
                redis.call('SET', KEYS[1], 'pending', 'EX', ARGV[1])
                return 1
            else
                return 0
            end";
        
        await _redis.ScriptEvaluateAsync(luaScript,
            new RedisKey[] { tokenKey },
            new RedisValue[] { expiry.TotalSeconds });
    }
}

// 使用示例
public class OrderServiceWithTwoPhase
{
    private readonly TwoPhaseTokenService _tokenService;
    
    public async Task<Order> CreateOrderAsync(
        CreateOrderRequest request,
        string token,
        TimeSpan tokenExpiry)
    {
        // 第一阶段：预留 Token
        var reserved = await _tokenService.ReserveTokenAsync(token, tokenExpiry);
        
        if (!reserved)
        {
            throw new InvalidOperationException("Token not available");
        }
        
        try
        {
            // 执行业务逻辑
            var order = await _orderService.CreateAsync(request);
            
            // 第二阶段a：确认完成
            await _tokenService.ConfirmTokenAsync(token);
            
            return order;
        }
        catch (Exception)
        {
            // 第二阶段b：回滚
            await _tokenService.RollbackTokenAsync(token, tokenExpiry);
            throw;
        }
    }
}
```

## 数据库实现

### PostgreSQL 原子操作

```sql
-- 使用 CTE 实现原子性的检查并删除
WITH deleted_token AS (
    DELETE FROM idempotency_tokens
    WHERE token = $1
      AND status = 'pending'
      AND expires_at > NOW()
    RETURNING token
)
SELECT CASE 
    WHEN EXISTS (SELECT 1 FROM deleted_token) THEN TRUE
    ELSE FALSE
END AS consumed;
```

```csharp
public class DatabaseTokenService
{
    private readonly AppDbContext _dbContext;
    
    public async Task<bool> TryConsumeTokenAsync(string token)
    {
        const string sql = @"
            WITH deleted_token AS (
                DELETE FROM idempotency_tokens
                WHERE token = @token
                  AND status = 'pending'
                  AND expires_at > NOW()
                RETURNING token
            )
            SELECT EXISTS (SELECT 1 FROM deleted_token)";
        
        await using var command = _dbContext.Database.GetDbConnection().CreateCommand();
        command.CommandText = sql;
        command.Parameters.AddWithValue("@token", token);
        
        await _dbContext.Database.OpenConnectionAsync();
        
        var result = await command.ExecuteScalarAsync();
        
        return Convert.ToBoolean(result);
    }
}
```

## 完整实战示例

### 支付系统的原子性 Token 处理

```csharp
public class PaymentServiceWithAtomicToken
{
    private readonly IDatabase _redis;
    private readonly AppDbContext _dbContext;
    
    private static readonly string ConsumeTokenScript = @"
        local key = KEYS[1]
        local status = redis.call('GET', key)
        
        if status == 'pending' then
            -- 标记为 processing
            redis.call('SET', key, 'processing')
            return 1
        elseif status == 'processing' then
            -- 正在处理中，返回特殊值
            return 2
        else
            -- Token 不存在或已完成
            return 0
        end";
    
    public async Task<Result<Payment>> ProcessPaymentAsync(
        PaymentRequest request,
        string idempotencyKey)
    {
        var tokenKey = $"payment:token:{idempotencyKey}";
        
        // 原子性地消耗 Token
        var result = await _redis.ScriptEvaluateAsync(
            ConsumeTokenScript,
            new RedisKey[] { tokenKey });
        
        var status = (int)result;
        
        if (status == 0)
        {
            // Token 不存在或已过期
            return Result<Payment>.Failure("Invalid or expired token");
        }
        
        if (status == 2)
        {
            // 正在处理中，返回冲突
            return Result<Payment>.Failure("Payment is being processed");
        }
        
        // status == 1: 成功获取 Token
        
        await using var transaction = await _dbContext.Database.BeginTransactionAsync();
        
        try
        {
            // 检查是否已有支付记录（双重保险）
            var existingPayment = await _dbContext.Payments
                .FirstOrDefaultAsync(p => p.IdempotencyKey == idempotencyKey);
            
            if (existingPayment != null)
            {
                // 删除 Redis Token
                await _redis.KeyDeleteAsync(tokenKey);
                
                return Result<Payment>.Success(existingPayment);
            }
            
            // 创建支付记录
            var payment = new Payment
            {
                Id = Guid.NewGuid(),
                IdempotencyKey = idempotencyKey,
                Amount = request.Amount,
                Status = "processing"
            };
            
            _dbContext.Payments.Add(payment);
            await _dbContext.SaveChangesAsync();
            
            // 调用支付网关
            var gatewayResult = await _paymentGateway.ChargeAsync(request);
            
            // 更新支付状态
            payment.Status = gatewayResult.Success ? "success" : "failed";
            payment.TransactionId = gatewayResult.TransactionId;
            
            await _dbContext.SaveChangesAsync();
            await transaction.CommitAsync();
            
            // 删除 Redis Token
            await _redis.KeyDeleteAsync(tokenKey);
            
            return Result<Payment>.Success(payment);
        }
        catch (Exception ex)
        {
            await transaction.RollbackAsync();
            
            // 失败时恢复 Token 状态，允许重试
            await _redis.StringSetAsync(tokenKey, "pending", TimeSpan.FromMinutes(30));
            
            return Result<Payment>.Failure($"Payment failed: {ex.Message}");
        }
    }
}
```

## 监控与告警

### 检测原子性问题

```csharp
public class AtomicityMonitor
{
    private readonly Counter<long> _atomicOperationFailures;
    private readonly Counter<long> _tokenInconsistencies;
    
    public void RecordAtomicOperationFailure(string operation, string reason)
    {
        _atomicOperationFailures.Add(1, 
            new KeyValuePair<string, object?>("operation", operation),
            new KeyValuePair<string, object?>("reason", reason));
    }
    
    public void RecordTokenInconsistency(string tokenKey, string expectedStatus, string actualStatus)
    {
        _tokenInconsistencies.Add(1,
            new KeyValuePair<string, object?>("token_key", tokenKey),
            new KeyValuePair<string, object?>("expected", expectedStatus),
            new KeyValuePair<string, object?>("actual", actualStatus));
    }
}
```

## 最佳实践总结

### ✅ DO

1. **使用 Lua 脚本**：保证 Redis 操作的原子性
2. **双重检查**：Redis + 数据库两层验证
3. **状态机管理**：pending → processing → completed
4. **失败回滚**：业务失败时恢复 Token 状态
5. **详细日志**：记录所有状态转换

### ❌ DON'T

1. **不要分离检查和删除**：会导致竞态条件
2. **不要忽略异常**：确保 Token 正确清理
3. **不要假设原子性**：明确使用原子操作
4. **不要忘记超时**：防止 Token 永久锁定

## 总结

Token 删除的原子性是幂等性系统的关键：

✅ **核心原则**：
- 检查和删除必须是原子操作
- 使用 Lua 脚本或数据库事务
- 实现状态机管理 Token 生命周期

✅ **推荐方案**：
- Redis Lua 脚本（高性能）
- 数据库 CTE（强一致性）
- 两阶段提交（复杂场景）

通过保证原子性，可以避免竞态条件和数据不一致问题。
