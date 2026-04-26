---
editLink: true
lastUpdated: true
---
# 全局唯一ID - 请求ID去重

## 目录
- [1. 概述](#1-概述)
- [2. ID 生成算法](#2-id-生成算法)
- [3. Snowflake 算法详解](#3-snowflake-算法详解)
- [4. C# 实现](#4-c-实现)
- [5. 数据库层面的唯一性保证](#5-数据库层面的唯一性保证)
- [6. 分布式环境下的应用](#6-分布式环境下的应用)
- [7. 最佳实践](#7-最佳实践)

---

## 1. 概述

### 1.1 为什么需要全局唯一ID？

在分布式系统中，全局唯一ID是幂等性设计的**基础设施**：

**应用场景**：
- **请求去重**：每个请求携带唯一ID，防止重复处理
- **订单号**：电商系统中的订单标识
- **流水号**：支付、库存等业务操作的业务主键
- **分布式追踪**：Trace ID 用于链路追踪
- **数据分片**：作为分库分表的路由键

**核心要求**：
- **唯一性**：全局不重复
- **趋势递增**：便于排序和索引
- **高性能**：低延迟生成
- **高可用**：分布式环境下持续可用
- **可读性**：便于排查问题（可选）

### 1.2 常见方案对比

| 方案 | 优点 | 缺点 | 适用场景 |
|------|------|------|---------|
| **UUID** | 简单，无依赖 | 过长，无序，性能差 | 通用场景 |
| **Snowflake** | 趋势递增，高性能 | 依赖时钟 | 分布式系统（推荐） |
| **数据库自增** | 简单可靠 | 单点瓶颈 | 单机应用 |
| **Redis INCR** | 性能好 | 依赖 Redis | 已有 Redis 基础设施 |
| **MongoDB ObjectId** | 自带时间戳 | 依赖 MongoDB | MongoDB 用户 |

---

## 2. ID 生成算法

### 2.1 UUID

```csharp
// UUID v4 (随机版本)
var uuid = Guid.NewGuid();
// 输出: 550e8400-e29b-41d4-a716-446655440000

// UUID v7 (时间排序，RFC 9562)
var uuidV7 = GenerateUuidV7(); // 自定义实现
```

**优点**：
- 简单易用，`Guid.NewGuid()` 一行代码
- 全球唯一，碰撞概率极低

**缺点**：
- 128位，过长（36字符）
- 无序，影响数据库索引性能
- 不包含时间信息

### 2.2 数据库自增

```sql
CREATE TABLE orders (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    order_no VARCHAR(50) NOT NULL UNIQUE,
    ...
);
```

**优点**：
- 简单可靠
- 有序，索引性能好

**缺点**：
- 单点瓶颈
- 分库分表复杂
- 暴露业务量

### 2.3 Redis INCR

```csharp
public class RedisIdGenerator
{
    private readonly IDatabase _redis;
    
    public async Task<long> NextIdAsync(string key)
    {
        return await _redis.StringIncrementAsync($"id:{key}");
    }
}
```

**优点**：
- 性能好
- 有序

**缺点**：
- 依赖 Redis
- 重启可能重复（需持久化）

### 2.4 Snowflake（雪花算法）

Twitter 开源的分布式 ID 生成算法，是目前**最流行**的方案。

**结构**（64位）：
```
┌─────────────────────────────────────────────────────────────┐
│  符号位 (1 bit)  |  时间戳 (41 bits)  |  机器ID (10 bits)  |  序列号 (12 bits)  │
│     0            │     毫秒级时间      │   数据中心+机器    │     自增序列      │
└─────────────────────────────────────────────────────────────┘
```

**特点**：
- 每秒可生成 409.6 万个 ID
- 趋势递增
- 不依赖外部存储
- 64位长整型，节省空间

---

## 3. Snowflake 算法详解

### 3.1 位运算实现

```csharp
namespace Idempotency.IdGeneration
{
    /// <summary>
    /// Snowflake ID 生成器
    /// </summary>
    public class SnowflakeIdGenerator
    {
        // 起始时间戳（2020-01-01 00:00:00 UTC）
        private const long Epoch = 1577836800000L;
        
        // 位数分配
        private const int TimestampBits = 41;
        private const int DatacenterBits = 5;
        private const int MachineBits = 5;
        private const int SequenceBits = 12;
        
        // 最大值
        private const long MaxDatacenterId = (1L << DatacenterBits) - 1; // 31
        private const long MaxMachineId = (1L << MachineBits) - 1;       // 31
        private const long MaxSequence = (1L << SequenceBits) - 1;       // 4095
        
        // 位移
        private const int TimestampShift = DatacenterBits + MachineBits + SequenceBits; // 22
        private const int DatacenterShift = MachineBits + SequenceBits;  // 17
        private const int MachineShift = SequenceBits;                   // 12
        
        private readonly long _datacenterId;
        private readonly long _machineId;
        private readonly object _lock = new();
        
        private long _lastTimestamp = -1L;
        private long _sequence = 0L;
        
        public SnowflakeIdGenerator(long datacenterId, long machineId)
        {
            if (datacenterId < 0 || datacenterId > MaxDatacenterId)
                throw new ArgumentException($"Datacenter ID must be between 0 and {MaxDatacenterId}");
            
            if (machineId < 0 || machineId > MaxMachineId)
                throw new ArgumentException($"Machine ID must be between 0 and {MaxMachineId}");
            
            _datacenterId = datacenterId;
            _machineId = machineId;
        }
        
        /// <summary>
        /// 生成下一个 ID
        /// </summary>
        public long NextId()
        {
            lock (_lock)
            {
                var timestamp = GetCurrentTimestamp();
                
                // 时钟回拨检测
                if (timestamp < _lastTimestamp)
                {
                    throw new InvalidOperationException(
                        $"Clock moved backwards. Refusing to generate ID for {_lastTimestamp - timestamp}ms");
                }
                
                // 同一毫秒内，序列号递增
                if (timestamp == _lastTimestamp)
                {
                    _sequence = (_sequence + 1) & MaxSequence;
                    
                    // 序列号溢出，等待下一毫秒
                    if (_sequence == 0)
                    {
                        timestamp = WaitForNextMillis(_lastTimestamp);
                    }
                }
                else
                {
                    // 不同毫秒，序列号重置
                    _sequence = 0L;
                }
                
                _lastTimestamp = timestamp;
                
                // 组合 ID
                return ((timestamp - Epoch) << TimestampShift) |
                       (_datacenterId << DatacenterShift) |
                       (_machineId << MachineShift) |
                       _sequence;
            }
        }
        
        private long GetCurrentTimestamp()
        {
            return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        }
        
        private long WaitForNextMillis(long lastTimestamp)
        {
            long timestamp;
            do
            {
                timestamp = GetCurrentTimestamp();
            } while (timestamp <= lastTimestamp);
            
            return timestamp;
        }
    }
}
```

### 3.2 改进版：支持时钟回拨

```csharp
public class ResilientSnowflakeIdGenerator
{
    private const long Epoch = 1577836800000L;
    private const int MaxSequence = 4095;
    
    private readonly long _datacenterId;
    private readonly long _machineId;
    private readonly object _lock = new();
    private readonly TimeSpan _maxClockBackward = TimeSpan.FromMilliseconds(100);
    
    private long _lastTimestamp = -1L;
    private long _sequence = 0L;
    
    public ResilientSnowflakeIdGenerator(long datacenterId, long machineId)
    {
        _datacenterId = datacenterId;
        _machineId = machineId;
    }
    
    public long NextId()
    {
        lock (_lock)
        {
            var timestamp = GetCurrentTimestamp();
            
            // 时钟回拨处理
            if (timestamp < _lastTimestamp)
            {
                var offset = _lastTimestamp - timestamp;
                
                // 小幅度回拨，等待
                if (offset <= _maxClockBackward.TotalMilliseconds)
                {
                    Thread.Sleep((int)offset);
                    timestamp = GetCurrentTimestamp();
                }
                else
                {
                    // 大幅度回拨，使用备用策略
                    return GenerateWithBackupStrategy(timestamp);
                }
            }
            
            if (timestamp == _lastTimestamp)
            {
                _sequence = (_sequence + 1) & MaxSequence;
                
                if (_sequence == 0)
                {
                    timestamp = WaitForNextMillis(_lastTimestamp);
                }
            }
            else
            {
                _sequence = 0L;
            }
            
            _lastTimestamp = timestamp;
            
            return ComposeId(timestamp - Epoch, _sequence);
        }
    }
    
    private long GenerateWithBackupStrategy(long timestamp)
    {
        // 备用策略：使用随机序列号
        var random = new Random();
        _sequence = random.Next(0, MaxSequence);
        
        return ComposeId(timestamp - Epoch, _sequence);
    }
    
    private long ComposeId(long timestamp, long sequence)
    {
        return (timestamp << 22) |
               (_datacenterId << 17) |
               (_machineId << 12) |
               sequence;
    }
}
```

---

## 4. C# 实现

### 4.1 统一 ID 生成服务

```csharp
namespace Idempotency.IdGeneration
{
    public interface IIdGenerator
    {
        /// <summary>
        /// 生成长整型 ID
        /// </summary>
        long NextLong();
        
        /// <summary>
        /// 生成字符串 ID
        /// </summary>
        string NextString();
        
        /// <summary>
        /// 生成 GUID
        /// </summary>
        Guid NextGuid();
    }
    
    public class CompositeIdGenerator : IIdGenerator
    {
        private readonly SnowflakeIdGenerator _snowflake;
        
        public CompositeIdGenerator(IConfiguration configuration)
        {
            var datacenterId = configuration.GetValue<long>("IdGeneration:DatacenterId");
            var machineId = configuration.GetValue<long>("IdGeneration:MachineId");
            
            _snowflake = new SnowflakeIdGenerator(datacenterId, machineId);
        }
        
        public long NextLong()
        {
            return _snowflake.NextId();
        }
        
        public string NextString()
        {
            return _snowflake.NextId().ToString();
        }
        
        public Guid NextGuid()
        {
            return Guid.NewGuid();
        }
    }
}
```

### 4.2 注册为单例服务

```csharp
// Program.cs
builder.Services.AddSingleton<IIdGenerator>(sp =>
{
    var config = builder.Configuration;
    return new CompositeIdGenerator(config);
});

// 或者使用配置
builder.Services.Configure<IdGeneratorOptions>(options =>
{
    options.DatacenterId = 1;
    options.MachineId = Environment.MachineName.GetHashCode() % 32;
});
```

### 4.3 生成订单号

```csharp
public class OrderNoGenerator
{
    private readonly IIdGenerator _idGenerator;
    
    public string Generate()
    {
        var id = _idGenerator.NextLong();
        var timestamp = DateTime.UtcNow.ToString("yyyyMMddHHmmss");
        
        // 格式：ORD20260408123456001234567890
        return $"ORD{timestamp}{id:D10}";
    }
}
```

---

## 5. 数据库层面的唯一性保证

### 5.1 使用唯一索引

```sql
-- 订单表
CREATE TABLE orders (
    id BIGINT PRIMARY KEY,
    order_no VARCHAR(50) NOT NULL UNIQUE, -- 唯一索引
    user_id BIGINT NOT NULL,
    total_amount DECIMAL(10, 2) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 流水表
CREATE TABLE payment_transactions (
    id BIGINT PRIMARY KEY,
    transaction_no VARCHAR(50) NOT NULL UNIQUE,
    order_id BIGINT NOT NULL,
    amount DECIMAL(10, 2) NOT NULL,
    status SMALLINT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### 5.2 幂等性实现

```csharp
public class OrderService
{
    private readonly OrderDbContext _dbContext;
    private readonly IIdGenerator _idGenerator;
    
    public async Task<Result<long>> CreateOrderAsync(CreateOrderRequest request)
    {
        // 生成唯一订单号
        var orderNo = GenerateOrderNo();
        
        try
        {
            var order = new Order
            {
                Id = _idGenerator.NextLong(),
                OrderNo = orderNo,
                UserId = request.UserId,
                TotalAmount = request.TotalAmount,
                CreatedAt = DateTime.UtcNow
            };
            
            _dbContext.Orders.Add(order);
            await _dbContext.SaveChangesAsync();
            
            return Result.Success(order.Id);
        }
        catch (DbUpdateException ex) when (IsUniqueViolation(ex))
        {
            // 订单号重复，返回已存在的订单
            var existingOrder = await _dbContext.Orders
                .Where(o => o.OrderNo == orderNo)
                .FirstOrDefaultAsync();
            
            return existingOrder != null 
                ? Result.Success(existingOrder.Id)
                : Result.Fail<long>("Failed to create order");
        }
    }
    
    private bool IsUniqueViolation(DbUpdateException ex)
    {
        return ex.InnerException is NpgsqlException npgEx && npgEx.SqlState == "23505";
    }
}
```

---

## 6. 分布式环境下的应用

### 6.1 客户端生成请求ID

```csharp
public class ApiClient
{
    private readonly HttpClient _httpClient;
    private readonly IIdGenerator _idGenerator;
    
    public async Task<HttpResponseMessage> PostAsync<T>(string url, T data)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, url);
        
        // 生成请求ID
        var requestId = _idGenerator.NextString();
        request.Headers.Add("X-Request-ID", requestId);
        
        request.Content = JsonContent.Create(data);
        
        return await _httpClient.SendAsync(request);
    }
}
```

### 6.2 服务端去重

```csharp
public class RequestDeduplicationMiddleware
{
    private readonly RequestDelegate _next;
    private readonly IDatabase _redis;
    
    public async Task InvokeAsync(HttpContext context)
    {
        // 提取请求ID
        if (context.Request.Headers.TryGetValue("X-Request-ID", out var requestIdHeader))
        {
            var requestId = requestIdHeader.ToString();
            var cacheKey = $"request:{requestId}";
            
            // 检查是否重复
            var exists = await _redis.StringGetAsync(cacheKey);
            if (exists.HasValue)
            {
                context.Response.StatusCode = StatusCodes.Status409Conflict;
                await context.Response.WriteAsync("Duplicate request");
                return;
            }
            
            // 标记为已处理
            await _redis.StringSetAsync(cacheKey, "1", TimeSpan.FromMinutes(5));
        }
        
        await _next(context);
    }
}
```

### 6.3 消息队列去重

```csharp
public class MessageConsumer
{
    private readonly IDatabase _redis;
    
    public async Task ConsumeAsync(Message message)
    {
        // 使用消息ID作为幂等键
        var idempotencyKey = $"message:{message.Id}";
        
        // 尝试获取锁
        var acquired = await _redis.StringSetAsync(
            idempotencyKey, 
            "processing", 
            TimeSpan.FromMinutes(10),
            When.NotExists);
        
        if (!acquired)
        {
            // 消息已在处理中
            return;
        }
        
        try
        {
            // 处理消息
            await ProcessMessageAsync(message);
            
            // 标记完成
            await _redis.StringSetAsync(idempotencyKey, "completed", TimeSpan.FromHours(1));
        }
        catch
        {
            // 失败，删除键，允许重试
            await _redis.KeyDeleteAsync(idempotencyKey);
            throw;
        }
    }
}
```

---

## 7. 最佳实践

### 7.1 ID 选择建议

| 场景 | 推荐方案 | 示例 |
|------|---------|------|
| **订单号** | Snowflake + 业务前缀 | ORD1234567890 |
| **请求ID** | Snowflake 字符串 | 1234567890123456 |
| **Trace ID** | UUID v4 | 550e8400-e29b-41d4-a716-446655440000 |
| **用户ID** | Snowflake | 1234567890123456 |
| **流水号** | Snowflake + 时间 | TXN20260408123456 |

### 7.2 配置管理

```json
{
  "IdGeneration": {
    "DatacenterId": 1,
    "MachineId": 5,
    "Epoch": "2020-01-01T00:00:00Z"
  }
}
```

### 7.3 监控告警

```csharp
public class IdGeneratorMetrics
{
    private readonly Counter<long> _idsGenerated;
    private readonly Counter<long> _clockBackwards;
    
    public void RecordIdGenerated()
    {
        _idsGenerated.Add(1);
    }
    
    public void RecordClockBackward(long offsetMs)
    {
        _clockBackwards.Add(1);
        _logger.LogWarning("Clock backward detected: {Offset}ms", offsetMs);
    }
}
```

### 7.4 测试

```csharp
[Fact]
public void TestIdUniqueness()
{
    var generator = new SnowflakeIdGenerator(1, 1);
    var ids = new ConcurrentBag<long>();
    
    Parallel.For(0, 100000, i =>
    {
        ids.Add(generator.NextId());
    });
    
    Assert.Equal(100000, ids.Distinct().Count());
}
```

---

## 总结

全局唯一ID是幂等性设计的基础设施：

### 核心要点

1. **Snowflake 算法**：分布式ID生成的最佳选择
2. **唯一索引**：数据库层面保证唯一性
3. **请求ID**：客户端生成，服务端去重
4. **监控告警**：检测时钟回拨等异常

### 最佳实践

- 使用 Snowflake 生成分布式ID
- 为业务ID添加唯一索引
- 客户端传递 X-Request-ID
- 监控ID生成速率和异常

通过统一的ID生成服务，可以在整个系统中实现高效的幂等性控制。
