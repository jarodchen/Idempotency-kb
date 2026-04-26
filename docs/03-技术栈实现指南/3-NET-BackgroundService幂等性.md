---
editLink: true
lastUpdated: true
---
# .NET - IHostedService 后台任务幂等性

## 目录
- [1. 概述](#1-概述)
- [2. IHostedService 基础](#2-ihostedservice-基础)
- [3. 定时任务的幂等性](#3-定时任务的幂等性)
- [4. 消息队列消费幂等](#4-消息队列消费幂等)
- [5. 完整示例](#5-完整示例)
- [6. 最佳实践](#6-最佳实践)

---

## 1. 概述

### 1.1 为什么后台任务需要幂等？

后台任务（Background Service）在执行时也可能遇到重复执行的问题：

**问题场景**：
- **应用重启**：定时任务正在执行，应用重启后再次触发
- **多实例部署**：多个服务实例同时运行同一任务
- **消息重试**：消息队列失败后重试，导致重复消费
- **手动触发**：运维人员手动重新执行任务

**后果**：
- 数据重复处理
- 业务逻辑错误
- 资源浪费

### 1.2 适用场景

| 场景 | 说明 | 幂等方案 |
|------|------|---------|
| **定时同步** | 定期从第三方同步数据 | 基于数据ID去重 |
| **数据清理** | 清理过期数据 | 基于状态检查 |
| **报表生成** | 生成每日报表 | 基于日期唯一索引 |
| **消息消费** | 消费 MQ 消息 | 基于消息ID |
| **订单超时** | 取消超时订单 | 基于订单状态 |

---

## 2. IHostedService 基础

### 2.1 基础实现

```csharp
namespace Idempotency.BackgroundTasks
{
    public class SimpleBackgroundService : IHostedService, IDisposable
    {
        private Timer? _timer;
        private readonly ILogger<SimpleBackgroundService> _logger;
        
        public SimpleBackgroundService(ILogger<SimpleBackgroundService> logger)
        {
            _logger = logger;
        }
        
        public Task StartAsync(CancellationToken cancellationToken)
        {
            _logger.LogInformation("Background service started");
            
            // 每5分钟执行一次
            _timer = new Timer(DoWork, null, TimeSpan.Zero, TimeSpan.FromMinutes(5));
            
            return Task.CompletedTask;
        }
        
        private void DoWork(object? state)
        {
            _logger.LogInformation("Background task executing at {Time}", DateTime.UtcNow);
            
            try
            {
                // 执行业务逻辑
                ProcessData();
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error in background task");
            }
        }
        
        private void ProcessData()
        {
            // 业务逻辑
        }
        
        public Task StopAsync(CancellationToken cancellationToken)
        {
            _logger.LogInformation("Background service stopping");
            
            _timer?.Change(Timeout.Infinite, 0);
            
            return Task.CompletedTask;
        }
        
        public void Dispose()
        {
            _timer?.Dispose();
        }
    }
}
```

### 2.2 注册服务

```csharp
// Program.cs
builder.Services.AddHostedService<SimpleBackgroundService>();
```

---

## 3. 定时任务的幂等性

### 3.1 基于数据库锁的幂等

```csharp
public class DataSyncService : IHostedService, IDisposable
{
    private Timer? _timer;
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<DataSyncService> _logger;
    
    public DataSyncService(
        IServiceScopeFactory scopeFactory,
        ILogger<DataSyncService> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
    }
    
    public Task StartAsync(CancellationToken cancellationToken)
    {
        // 每小时执行一次
        _timer = new Timer(ExecuteSync, null, TimeSpan.Zero, TimeSpan.FromHours(1));
        return Task.CompletedTask;
    }
    
    private async void ExecuteSync(object? state)
    {
        using var scope = _scopeFactory.CreateScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        
        var lockKey = "data_sync_lock";
        var lockValue = Guid.NewGuid().ToString();
        
        try
        {
            // 尝试获取分布式锁
            var acquired = await TryAcquireLockAsync(dbContext, lockKey, lockValue);
            
            if (!acquired)
            {
                _logger.LogWarning("Another instance is already running the sync task");
                return;
            }
            
            // 执行同步
            await PerformDataSyncAsync(scope.ServiceProvider);
            
            _logger.LogInformation("Data sync completed successfully");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error during data sync");
        }
        finally
        {
            // 释放锁
            await ReleaseLockAsync(dbContext, lockKey, lockValue);
        }
    }
    
    private async Task<bool> TryAcquireLockAsync(
        AppDbContext dbContext, 
        string lockKey, 
        string lockValue)
    {
        try
        {
            var now = DateTime.UtcNow;
            
            // 插入或更新锁记录
            var sql = @"
                INSERT INTO distributed_locks (lock_key, lock_value, expires_at)
                VALUES (@LockKey, @LockValue, @ExpiresAt)
                ON CONFLICT (lock_key) 
                DO UPDATE SET 
                    lock_value = EXCLUDED.lock_value,
                    expires_at = EXCLUDED.expires_at
                WHERE distributed_locks.expires_at < NOW()";
            
            var rowsAffected = await dbContext.Database.ExecuteSqlRawAsync(sql,
                new SqlParameter("@LockKey", lockKey),
                new SqlParameter("@LockValue", lockValue),
                new SqlParameter("@ExpiresAt", now.AddMinutes(30)));
            
            return rowsAffected > 0;
        }
        catch
        {
            return false;
        }
    }
    
    private async Task PerformDataSyncAsync(IServiceProvider serviceProvider)
    {
        var dbContext = serviceProvider.GetRequiredService<AppDbContext>();
        var externalApi = serviceProvider.GetRequiredService<IExternalApiClient>();
        
        // 1. 从外部 API 获取数据
        var externalData = await externalApi.FetchDataAsync();
        
        // 2. 幂等导入（基于唯一ID）
        foreach (var item in externalData)
        {
            var existing = await dbContext.ExternalRecords
                .Where(r => r.ExternalId == item.Id)
                .FirstOrDefaultAsync();
            
            if (existing == null)
            {
                // 新记录，插入
                var record = new ExternalRecord
                {
                    ExternalId = item.Id,
                    Data = JsonSerializer.Serialize(item),
                    SyncedAt = DateTime.UtcNow
                };
                
                dbContext.ExternalRecords.Add(record);
            }
            else
            {
                // 已存在，更新
                existing.Data = JsonSerializer.Serialize(item);
                existing.SyncedAt = DateTime.UtcNow;
            }
        }
        
        await dbContext.SaveChangesAsync();
    }
    
    private async Task ReleaseLockAsync(AppDbContext dbContext, string lockKey, string lockValue)
    {
        var sql = "DELETE FROM distributed_locks WHERE lock_key = @LockKey AND lock_value = @LockValue";
        
        await dbContext.Database.ExecuteSqlRawAsync(sql,
            new SqlParameter("@LockKey", lockKey),
            new SqlParameter("@LockValue", lockValue));
    }
    
    public Task StopAsync(CancellationToken cancellationToken)
    {
        _timer?.Change(Timeout.Infinite, 0);
        return Task.CompletedTask;
    }
    
    public void Dispose()
    {
        _timer?.Dispose();
    }
}
```

### 3.2 分布式锁表

```sql
-- 分布式锁表
CREATE TABLE distributed_locks (
    id SERIAL PRIMARY KEY,
    lock_key VARCHAR(100) NOT NULL UNIQUE, -- 锁键
    lock_value VARCHAR(100) NOT NULL, -- 锁持有者标识
    acquired_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(), -- 获取时间
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL, -- 过期时间
    
    CONSTRAINT chk_lock_expiry CHECK (expires_at > acquired_at)
);

-- 索引
CREATE INDEX idx_locks_expires ON distributed_locks(expires_at);

-- 注释
COMMENT ON TABLE distributed_locks IS '分布式锁表，用于防止任务重复执行';
COMMENT ON COLUMN distributed_locks.lock_key IS '锁的唯一标识';
COMMENT ON COLUMN distributed_locks.lock_value IS '锁持有者的唯一标识（UUID）';
```

---

## 4. 消息队列消费幂等

### 4.1 RabbitMQ 消费者

```csharp
using RabbitMQ.Client;
using RabbitMQ.Client.Events;

public class OrderMessageConsumer : IHostedService
{
    private readonly IConnection _connection;
    private readonly IModel _channel;
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<OrderMessageConsumer> _logger;
    
    public OrderMessageConsumer(
        IServiceScopeFactory scopeFactory,
        ILogger<OrderMessageConsumer> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
        
        var factory = new ConnectionFactory { HostName = "localhost" };
        _connection = factory.CreateConnection();
        _channel = _connection.CreateModel();
        
        // 声明队列
        _channel.QueueDeclare(
            queue: "order.events",
            durable: true,
            exclusive: false,
            autoDelete: false);
    }
    
    public Task StartAsync(CancellationToken cancellationToken)
    {
        var consumer = new EventingBasicConsumer(_channel);
        consumer.Received += async (model, ea) =>
        {
            var body = ea.Body.ToArray();
            var message = Encoding.UTF8.GetString(body);
            
            // 提取消息ID
            var messageId = ea.BasicProperties.MessageId;
            
            try
            {
                await ProcessMessageAsync(messageId, message);
                
                // 手动确认
                _channel.BasicAck(ea.DeliveryTag, false);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error processing message {MessageId}", messageId);
                
                // 拒绝消息，重新入队
                _channel.BasicNack(ea.DeliveryTag, false, true);
            }
        };
        
        _channel.BasicConsume(queue: "order.events", autoAck: false, consumer: consumer);
        
        _logger.LogInformation("Order message consumer started");
        
        return Task.CompletedTask;
    }
    
    private async Task ProcessMessageAsync(string messageId, string message)
    {
        using var scope = _scopeFactory.CreateScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        
        // 幂等性检查：基于消息ID
        var processed = await dbContext.ProcessedMessages
            .Where(m => m.MessageId == messageId)
            .AnyAsync();
        
        if (processed)
        {
            _logger.LogInformation("Message {MessageId} already processed", messageId);
            return; // 已处理，跳过
        }
        
        // 处理消息
        var orderEvent = JsonSerializer.Deserialize<OrderEvent>(message);
        await HandleOrderEventAsync(orderEvent, dbContext);
        
        // 记录已处理
        var processedMessage = new ProcessedMessage
        {
            MessageId = messageId,
            MessageType = orderEvent.Type,
            ProcessedAt = DateTime.UtcNow
        };
        
        dbContext.ProcessedMessages.Add(processedMessage);
        await dbContext.SaveChangesAsync();
        
        _logger.LogInformation("Message {MessageId} processed successfully", messageId);
    }
    
    private async Task HandleOrderEventAsync(OrderEvent orderEvent, AppDbContext dbContext)
    {
        switch (orderEvent.Type)
        {
            case "OrderCreated":
                await HandleOrderCreatedAsync(orderEvent, dbContext);
                break;
            case "OrderPaid":
                await HandleOrderPaidAsync(orderEvent, dbContext);
                break;
            default:
                _logger.LogWarning("Unknown event type: {Type}", orderEvent.Type);
                break;
        }
    }
    
    public Task StopAsync(CancellationToken cancellationToken)
    {
        _channel.Close();
        _connection.Close();
        
        _logger.LogInformation("Order message consumer stopped");
        
        return Task.CompletedTask;
    }
}

// 已处理消息记录表
public class ProcessedMessage
{
    public long Id { get; set; }
    public string MessageId { get; set; } = string.Empty;
    public string MessageType { get; set; } = string.Empty;
    public DateTime ProcessedAt { get; set; }
}
```

### 4.2 消息处理表

```sql
-- 已处理消息表
CREATE TABLE processed_messages (
    id BIGSERIAL PRIMARY KEY,
    message_id VARCHAR(200) NOT NULL UNIQUE, -- 消息ID
    message_type VARCHAR(50) NOT NULL, -- 消息类型
    payload JSONB, -- 消息内容（可选，用于审计）
    processed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    
    -- 保留7天，自动清理
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW() + INTERVAL '7 days'
);

-- 索引
CREATE INDEX idx_messages_expires ON processed_messages(expires_at);

-- 定时清理过期记录
CREATE OR REPLACE FUNCTION cleanup_processed_messages()
RETURNS void AS $$
BEGIN
    DELETE FROM processed_messages WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;
```

---

## 5. 完整示例

### 5.1 订单超时取消服务

```csharp
public class OrderTimeoutService : IHostedService, IDisposable
{
    private Timer? _timer;
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<OrderTimeoutService> _logger;
    private readonly string _instanceId;
    
    public OrderTimeoutService(
        IServiceScopeFactory scopeFactory,
        ILogger<OrderTimeoutService> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
        _instanceId = Guid.NewGuid().ToString();
    }
    
    public Task StartAsync(CancellationToken cancellationToken)
    {
        _logger.LogInformation("Order timeout service started. Instance: {InstanceId}", _instanceId);
        
        // 每分钟检查一次
        _timer = new Timer(CheckTimeoutOrders, null, TimeSpan.Zero, TimeSpan.FromMinutes(1));
        
        return Task.CompletedTask;
    }
    
    private async void CheckTimeoutOrders(object? state)
    {
        using var scope = _scopeFactory.CreateScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<OrderDbContext>();
        var lockKey = "order_timeout_check";
        
        try
        {
            // 尝试获取锁
            var acquired = await TryAcquireLockAsync(dbContext, lockKey);
            
            if (!acquired)
            {
                return; // 其他实例正在执行
            }
            
            // 查找超时未支付订单
            var timeoutOrders = await dbContext.Orders
                .Where(o => o.Status == OrderStatus.Pending 
                       && o.CreatedAt < DateTime.UtcNow.AddMinutes(-30))
                .ToListAsync();
            
            _logger.LogInformation("Found {Count} timeout orders", timeoutOrders.Count);
            
            // 取消订单并释放库存
            foreach (var order in timeoutOrders)
            {
                try
                {
                    order.Status = OrderStatus.Cancelled;
                    order.CancelledAt = DateTime.UtcNow;
                    order.StatusMessage = "超时自动取消";
                    
                    // 释放库存
                    await ReleaseInventoryAsync(order, dbContext);
                    
                    _logger.LogInformation("Order {OrderId} cancelled due to timeout", order.Id);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Error cancelling order {OrderId}", order.Id);
                }
            }
            
            await dbContext.SaveChangesAsync();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in timeout check");
        }
        finally
        {
            await ReleaseLockAsync(dbContext, lockKey);
        }
    }
    
    private async Task<bool> TryAcquireLockAsync(OrderDbContext dbContext, string lockKey)
    {
        try
        {
            var sql = @"
                INSERT INTO distributed_locks (lock_key, lock_value, expires_at)
                VALUES (@Key, @Value, @Expiry)
                ON CONFLICT (lock_key) 
                DO UPDATE SET lock_value = EXCLUDED.lock_value, expires_at = EXCLUDED.expires_at
                WHERE distributed_locks.expires_at < NOW()";
            
            var rows = await dbContext.Database.ExecuteSqlRawAsync(sql,
                new SqlParameter("@Key", lockKey),
                new SqlParameter("@Value", _instanceId),
                new SqlParameter("@Expiry", DateTime.UtcNow.AddMinutes(5)));
            
            return rows > 0;
        }
        catch
        {
            return false;
        }
    }
    
    private async Task ReleaseInventoryAsync(Order order, OrderDbContext dbContext)
    {
        var product = await dbContext.Products.FindAsync(order.ProductId);
        
        if (product != null)
        {
            product.Stock += order.Quantity;
            product.Version++;
        }
    }
    
    private async Task ReleaseLockAsync(OrderDbContext dbContext, string lockKey)
    {
        var sql = "DELETE FROM distributed_locks WHERE lock_key = @Key";
        await dbContext.Database.ExecuteSqlRawAsync(sql,
            new SqlParameter("@Key", lockKey));
    }
    
    public Task StopAsync(CancellationToken cancellationToken)
    {
        _timer?.Change(Timeout.Infinite, 0);
        _logger.LogInformation("Order timeout service stopped");
        return Task.CompletedTask;
    }
    
    public void Dispose()
    {
        _timer?.Dispose();
    }
}
```

---

## 6. 最佳实践

### 6.1 异常处理

```csharp
// ✅ 推荐：捕获所有异常，避免后台任务崩溃
private async void ExecuteSafely()
{
    try
    {
        await DoWorkAsync();
    }
    catch (Exception ex)
    {
        _logger.LogError(ex, "Unhandled exception in background task");
        // 不要抛出异常，否则会导致应用崩溃
    }
}

// ❌ 避免：不捕获异常
private async void ExecuteUnsafe()
{
    await DoWorkAsync(); // 异常会导致应用崩溃
}
```

### 6.2 优雅关闭

```csharp
public class GracefulShutdownService : IHostedService
{
    private volatile bool _stopping = false;
    
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        while (!_stopping)
        {
            try
            {
                await ProcessNextItemAsync();
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                // 优雅退出
                break;
            }
        }
    }
    
    public Task StopAsync(CancellationToken cancellationToken)
    {
        _stopping = true;
        return Task.CompletedTask;
    }
}
```

### 6.3 监控指标

```csharp
public class BackgroundTaskMetrics
{
    private readonly Counter<long> _executionsTotal;
    private readonly Counter<long> _failuresTotal;
    private readonly Histogram<double> _executionDuration;
    
    public void RecordExecution(bool success, double durationMs)
    {
        _executionsTotal.Add(1);
        
        if (!success)
            _failuresTotal.Add(1);
        
        _executionDuration.Record(durationMs);
    }
}
```

---

## 总结

后台任务的幂等性是保证系统稳定性的关键：

### 核心要点

1. **分布式锁**：防止多实例重复执行
2. **唯一索引**：防止数据重复处理
3. **消息ID去重**：保证消息消费的幂等性
4. **异常处理**：避免后台任务崩溃

### 最佳实践

- ✅ 使用分布式锁协调多实例
- ✅ 基于业务键实现幂等性
- ✅ 记录已处理的消息/任务
- ✅ 完善的日志和监控
- ✅ 优雅关闭，避免中断任务

通过完善的幂等性设计，可以让后台任务在高可用环境下稳定运行。
