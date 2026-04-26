---
editLink: true
lastUpdated: true
---
# MySQL 唯一索引 - 幂等性实现指南

## 目录
- [1. 概述](#1-概述)
- [2. MySQL 唯一索引基础](#2-mysql-唯一索引基础)
- [3. 单列唯一索引](#3-单列唯一索引)
- [4. 复合唯一索引](#4-复合唯一索引)
- [5. 部分唯一索引（条件唯一）](#5-部分唯一索引条件唯一)
- [6. UPSERT 操作](#6-upsert-操作)
- [7. C# 实战示例](#7-c-实战示例)
- [8. 性能优化与最佳实践](#8-性能优化与最佳实践)

---

## 1. 概述

### 1.1 为什么使用 MySQL 唯一索引实现幂等？

在分布式系统中，MySQL 唯一索引是实现幂等性的**最简单、最可靠**的方式之一：

**优势**：
- **数据库层面保证**：不依赖应用层逻辑，由数据库引擎强制约束
- **原子性**：INSERT 操作要么成功，要么失败，不存在中间状态
- **简洁性**：无需额外的表或复杂的逻辑
- **高性能**：索引查找 O(log n)，远快于应用层查询+判断

**适用场景**：
- 订单创建（防止重复下单）
- 支付回调处理（防止重复扣款）
- 用户注册（防止重复注册）
- 数据同步（防止重复插入）
- 消息队列消费（防止重复消费）

### 1.2 核心原理

```
┌─────────────────────────────────────────┐
│         应用程序                         │
│                                          │
│  INSERT INTO orders (order_no, ...)     │
│  VALUES ('ORD001', ...);                │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│         MySQL 数据库                     │
│                                          │
│  检查唯一索引: order_no = 'ORD001'      │
│                                          │
│  ├─ 不存在 → 插入成功 ✓                 │
│  └─ 已存在 → 抛出错误 ✗                 │
│       Duplicate entry 'ORD001'           │
└─────────────────────────────────────────┘
```

---

## 2. MySQL 唯一索引基础

### 2.1 唯一索引 vs 普通索引

| 特性 | 普通索引 (INDEX) | 唯一索引 (UNIQUE INDEX) |
|------|------------------|------------------------|
| 允许重复值 | ✅ 是 | ❌ 否 |
| 允许 NULL 值 | ✅ 是 | ✅ 是（多个 NULL 不算重复） |
| 性能 | 相同 | 相同 |
| 用途 | 加速查询 | 加速查询 + 数据唯一性约束 |

### 2.2 创建唯一索引的语法

```sql
-- 方式1: 创建表时定义
CREATE TABLE users (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(100) NOT NULL,
    UNIQUE INDEX uk_email (email)
);

-- 方式2: 在现有表上添加
CREATE UNIQUE INDEX uk_email ON users(email);

-- 方式3: 使用 ALTER TABLE
ALTER TABLE users ADD UNIQUE INDEX uk_email (email);
```

### 2.3 查看唯一索引

```sql
-- 查看表的所有索引
SHOW INDEX FROM users;

-- 从 information_schema 查询
SELECT 
    INDEX_NAME,
    COLUMN_NAME,
    NON_UNIQUE,
    SEQ_IN_INDEX
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = 'your_database'
  AND TABLE_NAME = 'users';
```

---

## 3. 单列唯一索引

### 3.1 用户邮箱唯一性示例

```sql
-- 创建用户表
CREATE TABLE users (
    id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '用户ID',
    username VARCHAR(50) NOT NULL COMMENT '用户名',
    email VARCHAR(100) NOT NULL COMMENT '邮箱',
    phone VARCHAR(20) COMMENT '手机号',
    password_hash VARCHAR(255) NOT NULL COMMENT '密码哈希',
    
    -- 审计字段
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    deleted_at TIMESTAMP NULL COMMENT '删除时间（软删除）',
    
    -- 唯一索引：邮箱不能重复
    UNIQUE INDEX uk_email (email),
    
    -- 唯一索引：用户名不能重复
    UNIQUE INDEX uk_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户表';
```

### 3.2 C# 实现：用户注册防重

```csharp
using Microsoft.EntityFrameworkCore;
using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

namespace Idempotency.UserManagement.Models
{
    [Table("users")]
    public class User
    {
        [Key]
        [Column("id")]
        public long Id { get; set; }
        
        [Required]
        [Column("username")]
        [StringLength(50)]
        public string Username { get; set; }
        
        [Required]
        [Column("email")]
        [StringLength(100)]
        public string Email { get; set; }
        
        [Column("phone")]
        [StringLength(20)]
        public string? Phone { get; set; }
        
        [Required]
        [Column("password_hash")]
        [StringLength(255)]
        public string PasswordHash { get; set; }
        
        [Column("created_at")]
        public DateTime CreatedAt { get; set; }
        
        [Column("updated_at")]
        public DateTime UpdatedAt { get; set; }
        
        [Column("deleted_at")]
        public DateTime? DeletedAt { get; set; }
    }
}
```

```csharp
using Microsoft.EntityFrameworkCore;

namespace Idempotency.UserManagement.Data
{
    public class UserDbContext : DbContext
    {
        public DbSet<User> Users { get; set; }
        
        public UserDbContext(DbContextOptions<UserDbContext> options) 
            : base(options)
        {
        }
        
        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            // 配置唯一索引
            modelBuilder.Entity<User>(entity =>
            {
                entity.HasIndex(u => u.Email).IsUnique();
                entity.HasIndex(u => u.Username).IsUnique();
                
                // 软删除过滤
                entity.HasQueryFilter(u => !u.DeletedAt.HasValue);
            });
        }
    }
}
```

```csharp
using Microsoft.EntityFrameworkCore;

namespace Idempotency.UserManagement.Services
{
    public interface IUserService
    {
        Task<Result<long>> RegisterAsync(RegisterRequest request);
    }
    
    public class UserService : IUserService
    {
        private readonly UserDbContext _dbContext;
        private readonly ILogger<UserService> _logger;
        
        public UserService(UserDbContext dbContext, ILogger<UserService> logger)
        {
            _dbContext = dbContext;
            _logger = logger;
        }
        
        /// <summary>
        /// 用户注册（利用唯一索引防止重复）
        /// </summary>
        public async Task<Result<long>> RegisterAsync(RegisterRequest request)
        {
            try
            {
                var user = new User
                {
                    Username = request.Username,
                    Email = request.Email.ToLower(), // 统一转小写，避免大小写问题
                    Phone = request.Phone,
                    PasswordHash = BCrypt.Net.BCrypt.HashPassword(request.Password),
                    CreatedAt = DateTime.UtcNow,
                    UpdatedAt = DateTime.UtcNow
                };
                
                _dbContext.Users.Add(user);
                await _dbContext.SaveChangesAsync();
                
                _logger.LogInformation("User registered successfully. Email: {Email}, UserId: {UserId}", 
                    user.Email, user.Id);
                
                return Result.Success(user.Id);
            }
            catch (DbUpdateException ex) when (IsUniqueConstraintViolation(ex))
            {
                // 提取冲突的字段名
                var conflictingField = ExtractConflictingField(ex);
                
                _logger.LogWarning("Duplicate registration attempt. Field: {Field}, Value: {Value}", 
                    conflictingField, 
                    conflictingField == "email" ? request.Email : request.Username);
                
                return Result.Fail<long>(
                    $"Registration failed: {conflictingField} already exists.");
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error registering user. Email: {Email}", request.Email);
                return Result.Fail<long>("Registration failed due to internal error.");
            }
        }
        
        /// <summary>
        /// 判断是否为唯一约束违反异常
        /// </summary>
        private bool IsUniqueConstraintViolation(DbUpdateException ex)
        {
            if (ex.InnerException is MySqlException mysqlEx)
            {
                // MySQL 错误码 1062: Duplicate entry
                return mysqlEx.Number == 1062;
            }
            return false;
        }
        
        /// <summary>
        /// 提取冲突的字段名
        /// </summary>
        private string ExtractConflictingField(DbUpdateException ex)
        {
            if (ex.InnerException?.Message.Contains("email") == true)
                return "email";
            if (ex.InnerException?.Message.Contains("username") == true)
                return "username";
            return "unknown";
        }
    }
    
    public record RegisterRequest(
        string Username,
        string Email,
        string Password,
        string? Phone
    );
}
```

### 3.3 处理软删除后的唯一性

**问题**：用户删除后重新注册，唯一索引会冲突

**解决方案1：使用部分唯一索引（MySQL 8.0.13+）**

```sql
-- 只对未删除的记录建立唯一索引
CREATE UNIQUE INDEX uk_email_not_deleted 
ON users(email) 
WHERE deleted_at IS NULL;

-- 这样，已删除的用户可以重新注册
```

**解决方案2：手动检查（适用于旧版本 MySQL）**

```csharp
public async Task<Result<long>> RegisterWithSoftDeleteAsync(RegisterRequest request)
{
    using var transaction = await _dbContext.Database.BeginTransactionAsync();
    
    try
    {
        // 检查是否存在未删除的用户
        var existingUser = await _dbContext.Users
            .IgnoreQueryFilters() // 忽略软删除过滤器
            .Where(u => u.Email == request.Email.ToLower() && !u.DeletedAt.HasValue)
            .FirstOrDefaultAsync();
        
        if (existingUser != null)
        {
            return Result.Fail<long>("Email already registered.");
        }
        
        // 检查是否存在已删除的用户，如果有则恢复
        var deletedUser = await _dbContext.Users
            .IgnoreQueryFilters()
            .Where(u => u.Email == request.Email.ToLower() && u.DeletedAt.HasValue)
            .OrderByDescending(u => u.DeletedAt)
            .FirstOrDefaultAsync();
        
        if (deletedUser != null)
        {
            // 恢复已删除的用户
            deletedUser.DeletedAt = null;
            deletedUser.Username = request.Username;
            deletedUser.PasswordHash = BCrypt.Net.BCrypt.HashPassword(request.Password);
            deletedUser.UpdatedAt = DateTime.UtcNow;
            
            await _dbContext.SaveChangesAsync();
            await transaction.CommitAsync();
            
            return Result.Success(deletedUser.Id);
        }
        
        // 创建新用户
        var newUser = new User
        {
            Username = request.Username,
            Email = request.Email.ToLower(),
            PasswordHash = BCrypt.Net.BCrypt.HashPassword(request.Password),
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow
        };
        
        _dbContext.Users.Add(newUser);
        await _dbContext.SaveChangesAsync();
        await transaction.CommitAsync();
        
        return Result.Success(newUser.Id);
    }
    catch (Exception ex)
    {
        await transaction.RollbackAsync();
        throw;
    }
}
```

---

## 4. 复合唯一索引

### 4.1 订单明细表示例

```sql
-- 创建订单明细表
CREATE TABLE order_items (
    id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键',
    order_id BIGINT NOT NULL COMMENT '订单ID',
    product_id BIGINT NOT NULL COMMENT '商品ID',
    product_name VARCHAR(200) NOT NULL COMMENT '商品名称',
    quantity INT NOT NULL DEFAULT 1 COMMENT '数量',
    unit_price DECIMAL(10, 2) NOT NULL COMMENT '单价',
    total_amount DECIMAL(10, 2) NOT NULL COMMENT '小计',
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    -- 复合唯一索引：同一订单中同一商品只能有一条记录
    UNIQUE INDEX uk_order_product (order_id, product_id),
    
    -- 普通索引：加速查询
    INDEX idx_order_id (order_id),
    INDEX idx_product_id (product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单明细表';
```

### 4.2 应用场景：防止重复添加商品

```csharp
public class OrderItemService
{
    private readonly OrderDbContext _dbContext;
    
    public async Task<Result> AddOrderItemAsync(long orderId, long productId, int quantity)
    {
        try
        {
            var orderItem = new OrderItem
            {
                OrderId = orderId,
                ProductId = productId,
                Quantity = quantity,
                UnitPrice = await GetProductPriceAsync(productId),
                TotalAmount = quantity * await GetProductPriceAsync(productId)
            };
            
            _dbContext.OrderItems.Add(orderItem);
            await _dbContext.SaveChangesAsync();
            
            return Result.Success();
        }
        catch (DbUpdateException ex) when (IsUniqueConstraintViolation(ex))
        {
            return Result.Fail(
                "Product already exists in this order. Please update quantity instead.");
        }
    }
    
    /// <summary>
    /// 更新订单商品数量（UPSERT 模式）
    /// </summary>
    public async Task<Result> UpsertOrderItemAsync(long orderId, long productId, int quantity)
    {
        try
        {
            // 尝试插入或更新
            var sql = @"
                INSERT INTO order_items (order_id, product_id, quantity, unit_price, total_amount)
                VALUES (@OrderId, @ProductId, @Quantity, @UnitPrice, @TotalAmount)
                ON DUPLICATE KEY UPDATE
                    quantity = VALUES(quantity),
                    total_amount = VALUES(total_amount),
                    updated_at = NOW()";
            
            var unitPrice = await GetProductPriceAsync(productId);
            var totalAmount = quantity * unitPrice;
            
            await _dbContext.Database.ExecuteSqlRawAsync(sql, 
                new SqlParameter("@OrderId", orderId),
                new SqlParameter("@ProductId", productId),
                new SqlParameter("@Quantity", quantity),
                new SqlParameter("@UnitPrice", unitPrice),
                new SqlParameter("@TotalAmount", totalAmount));
            
            return Result.Success();
        }
        catch (Exception ex)
        {
            return Result.Fail($"Failed to update order item: {ex.Message}");
        }
    }
}
```

### 4.3 消息队列消费记录

```sql
-- 创建消息消费记录表
CREATE TABLE message_consumption_records (
    id BIGSERIAL PRIMARY KEY,
    message_id VARCHAR(100) NOT NULL COMMENT '消息ID',
    consumer_group VARCHAR(100) NOT NULL COMMENT '消费者组',
    processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '处理时间',
    status SMALLINT NOT NULL DEFAULT 1 COMMENT '状态: 1=成功, 2=失败',
    error_message TEXT,
    
    -- 复合唯一索引：同一消息在同一消费者组中只能被消费一次
    UNIQUE INDEX uk_message_consumer (message_id, consumer_group),
    
    INDEX idx_message_id (message_id),
    INDEX idx_consumer_group (consumer_group)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='消息消费记录表';
```

```csharp
public class MessageConsumerService
{
    private readonly AppDbContext _dbContext;
    
    /// <summary>
    /// 处理消息（幂等）
    /// </summary>
    public async Task<bool> ProcessMessageAsync(string messageId, string consumerGroup, Func<Task> handler)
    {
        try
        {
            // 记录消费状态
            var record = new MessageConsumptionRecord
            {
                MessageId = messageId,
                ConsumerGroup = consumerGroup,
                ProcessedAt = DateTime.UtcNow,
                Status = 1
            };
            
            _dbContext.MessageConsumptionRecords.Add(record);
            await _dbContext.SaveChangesAsync();
            
            // 执行实际的消息处理
            await handler();
            
            return true;
        }
        catch (DbUpdateException ex) when (IsUniqueConstraintViolation(ex))
        {
            // 消息已被消费过，跳过
            Console.WriteLine($"Message {messageId} already consumed by {consumerGroup}");
            return false;
        }
        catch (Exception ex)
        {
            // 记录失败状态
            await RecordFailureAsync(messageId, consumerGroup, ex.Message);
            throw;
        }
    }
    
    private async Task RecordFailureAsync(string messageId, string consumerGroup, string errorMessage)
    {
        var sql = @"
            INSERT INTO message_consumption_records (message_id, consumer_group, status, error_message)
            VALUES (@MessageId, @ConsumerGroup, 2, @ErrorMessage)
            ON DUPLICATE KEY UPDATE
                status = 2,
                error_message = VALUES(error_message)";
        
        await _dbContext.Database.ExecuteSqlRawAsync(sql,
            new SqlParameter("@MessageId", messageId),
            new SqlParameter("@ConsumerGroup", consumerGroup),
            new SqlParameter("@ErrorMessage", errorMessage));
    }
}
```

---

## 5. 部分唯一索引（条件唯一）

### 5.1 MySQL 8.0.13+ 支持

```sql
-- 只对未来事件建立唯一索引（允许历史事件重名）
CREATE UNIQUE INDEX uk_future_event_name 
ON events(event_name) 
WHERE event_date > CURDATE();

-- 只对活跃用户建立唯一索引
CREATE UNIQUE INDEX uk_active_username 
ON users(username) 
WHERE status = 'active';

-- 只对未删除的记录建立唯一索引
CREATE UNIQUE INDEX uk_not_deleted_email 
ON users(email) 
WHERE deleted_at IS NULL;
```

### 5.2 旧版本 MySQL 的替代方案

对于不支持部分索引的 MySQL 版本，可以使用**触发器**或**计算列**模拟：

**方案1：使用触发器**

```sql
DELIMITER $$

CREATE TRIGGER trg_check_active_username
BEFORE INSERT ON users
FOR EACH ROW
BEGIN
    DECLARE existing_count INT;
    
    -- 检查是否存在同名的活跃用户
    SELECT COUNT(*) INTO existing_count
    FROM users
    WHERE username = NEW.username AND status = 'active';
    
    IF existing_count > 0 THEN
        SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Username already exists for active user';
    END IF;
END$$

DELIMITER ;
```

**方案2：使用计算列 + 唯一索引**

```sql
ALTER TABLE users 
ADD COLUMN unique_username_constraint VARCHAR(100) 
GENERATED ALWAYS AS (
    CASE WHEN status = 'active' THEN username ELSE CONCAT(username, '_', id) END
) STORED;

CREATE UNIQUE INDEX uk_active_username_v2 ON users(unique_username_constraint);
```

---

## 6. UPSERT 操作

### 6.1 INSERT ... ON DUPLICATE KEY UPDATE

```sql
-- 基本语法
INSERT INTO users (email, username, phone, updated_at)
VALUES ('john@example.com', 'john_doe', '1234567890', NOW())
ON DUPLICATE KEY UPDATE
    username = VALUES(username),
    phone = VALUES(phone),
    updated_at = VALUES(updated_at);

-- 使用场景：用户信息更新或插入
```

### 6.2 REPLACE INTO（删除后重新插入）

```sql
-- 注意：REPLACE INTO 会先删除旧记录再插入新记录
REPLACE INTO users (email, username, phone)
VALUES ('john@example.com', 'john_doe', '1234567890');

-- 警告：这会改变主键 ID，慎用！
```

### 6.3 批量 UPSERT

```sql
-- 批量插入或更新
INSERT INTO products (product_id, name, price, stock)
VALUES 
    (1, 'Product A', 100.00, 50),
    (2, 'Product B', 200.00, 30),
    (3, 'Product C', 150.00, 20)
ON DUPLICATE KEY UPDATE
    name = VALUES(name),
    price = VALUES(price),
    stock = VALUES(stock),
    updated_at = NOW();
```

### 6.4 C# 实现批量 UPSERT

```csharp
public class ProductService
{
    private readonly AppDbContext _dbContext;
    
    public async Task<int> BulkUpsertProductsAsync(List<ProductDto> products)
    {
        var sql = @"
            INSERT INTO products (product_id, name, price, stock, updated_at)
            VALUES 
                (@ProductId, @Name, @Price, @Stock, NOW())
            ON DUPLICATE KEY UPDATE
                name = VALUES(name),
                price = VALUES(price),
                stock = VALUES(stock),
                updated_at = NOW()";
        
        var parameters = new List<MySqlParameter>();
        var valueClauses = new List<string>();
        
        for (int i = 0; i < products.Count; i++)
        {
            var prefix = $"@p{i}_";
            valueClauses.Add($"({prefix}ProductId, {prefix}Name, {prefix}Price, {prefix}Stock)");
            
            parameters.AddRange(new[]
            {
                new MySqlParameter($"{prefix}ProductId", products[i].ProductId),
                new MySqlParameter($"{prefix}Name", products[i].Name),
                new MySqlParameter($"{prefix}Price", products[i].Price),
                new MySqlParameter($"{prefix}Stock", products[i].Stock)
            });
        }
        
        var finalSql = sql.Replace("VALUES \n", 
            "VALUES\n" + string.Join(",\n", valueClauses));
        
        return await _dbContext.Database.ExecuteSqlRawAsync(finalSql, parameters);
    }
}
```

---

## 7. C# 实战示例

### 7.1 通用唯一索引冲突检测

```csharp
using Microsoft.EntityFrameworkCore;
using MySqlConnector;

namespace Idempotency.Infrastructure
{
    public class UniqueConstraintHelper
    {
        /// <summary>
        /// 安全地执行插入操作，自动处理唯一索引冲突
        /// </summary>
        public static async Task<T> SafeInsertAsync<T>(
            DbContext context,
            T entity,
            Func<DbUpdateException, string> conflictResolver,
            CancellationToken cancellationToken = default) where T : class
        {
            try
            {
                context.Set<T>().Add(entity);
                await context.SaveChangesAsync(cancellationToken);
                return entity;
            }
            catch (DbUpdateException ex) when (IsUniqueConstraintViolation(ex))
            {
                var conflictMessage = conflictResolver(ex);
                throw new InvalidOperationException(
                    $"Unique constraint violation: {conflictMessage}", ex);
            }
        }
        
        /// <summary>
        /// 判断是否为唯一约束违反
        /// </summary>
        public static bool IsUniqueConstraintViolation(DbUpdateException ex)
        {
            if (ex.InnerException is MySqlException mysqlEx)
            {
                return mysqlEx.Number == 1062; // MySQL 错误码
            }
            return false;
        }
        
        /// <summary>
        /// 提取冲突的索引名
        /// </summary>
        public static string? ExtractConstraintName(DbUpdateException ex)
        {
            var match = System.Text.RegularExpressions.Regex.Match(
                ex.InnerException?.Message ?? "",
                "for key '([^']+)'");
            
            return match.Success ? match.Groups[1].Value : null;
        }
    }
}
```

### 7.2 基于唯一索引的幂等服务基类

```csharp
namespace Idempotency.Infrastructure
{
    public abstract class IdempotentServiceBase
    {
        protected readonly DbContext _dbContext;
        protected readonly ILogger _logger;
        
        protected IdempotentServiceBase(DbContext dbContext, ILogger logger)
        {
            _dbContext = dbContext;
            _logger = logger;
        }
        
        /// <summary>
        /// 执行幂等操作
        /// </summary>
        protected async Task<TResult> ExecuteIdempotentOperationAsync<TResult>(
            string operationName,
            string idempotencyKey,
            Func<Task<TResult>> operation,
            Func<Exception, TResult> onDuplicateKey)
        {
            try
            {
                var result = await operation();
                _logger.LogInformation("Operation {Operation} succeeded with key {Key}", 
                    operationName, idempotencyKey);
                return result;
            }
            catch (DbUpdateException ex) when (UniqueConstraintHelper.IsUniqueConstraintViolation(ex))
            {
                _logger.LogWarning("Duplicate operation detected. Operation: {Operation}, Key: {Key}", 
                    operationName, idempotencyKey);
                return onDuplicateKey(ex);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Operation {Operation} failed with key {Key}", 
                    operationName, idempotencyKey);
                throw;
            }
        }
    }
}
```

### 7.3 完整示例：订单创建服务

```csharp
using Microsoft.EntityFrameworkCore;

namespace Idempotency.OrderManagement.Services
{
    public class OrderCreationService : IdempotentServiceBase
    {
        public OrderCreationService(OrderDbContext dbContext, ILogger<OrderCreationService> logger)
            : base(dbContext, logger)
        {
        }
        
        /// <summary>
        /// 创建订单（幂等）
        /// </summary>
        public async Task<Result<long>> CreateOrderAsync(CreateOrderRequest request)
        {
            var idempotencyKey = $"order_{request.UserId}_{request.RequestId}";
            
            return await ExecuteIdempotentOperationAsync(
                "CreateOrder",
                idempotencyKey,
                async () =>
                {
                    using var transaction = await _dbContext.Database.BeginTransactionAsync();
                    
                    try
                    {
                        // 1. 创建订单
                        var order = new Order
                        {
                            OrderNo = GenerateOrderNo(),
                            UserId = request.UserId,
                            TotalAmount = request.Items.Sum(i => i.Price * i.Quantity),
                            Status = OrderStatus.Pending,
                            IdempotencyKey = idempotencyKey,
                            CreatedAt = DateTime.UtcNow
                        };
                        
                        _dbContext.Orders.Add(order);
                        await _dbContext.SaveChangesAsync();
                        
                        // 2. 创建订单明细
                        foreach (var item in request.Items)
                        {
                            var orderItem = new OrderItem
                            {
                                OrderId = order.Id,
                                ProductId = item.ProductId,
                                Quantity = item.Quantity,
                                UnitPrice = item.Price,
                                TotalAmount = item.Price * item.Quantity
                            };
                            
                            _dbContext.OrderItems.Add(orderItem);
                        }
                        
                        await _dbContext.SaveChangesAsync();
                        await transaction.CommitAsync();
                        
                        return Result.Success(order.Id);
                    }
                    catch
                    {
                        await transaction.RollbackAsync();
                        throw;
                    }
                },
                ex =>
                {
                    // 返回已存在的订单ID
                    var existingOrder = _dbContext.Orders
                        .Where(o => o.IdempotencyKey == idempotencyKey)
                        .FirstOrDefault();
                    
                    return existingOrder != null 
                        ? Result.Success(existingOrder.Id)
                        : Result.Fail<long>("Order creation failed");
                });
        }
        
        private string GenerateOrderNo()
        {
            return $"ORD{DateTime.UtcNow:yyyyMMddHHmmss}{Guid.NewGuid():N[..8]}";
        }
    }
}
```

---

## 8. 性能优化与最佳实践

### 8.1 索引性能考虑

#### ✅ 推荐做法

1. **控制唯一索引数量**
   ```sql
   -- 每个唯一索引都会降低写入性能
   -- 只为真正需要唯一性的字段创建
   CREATE UNIQUE INDEX uk_critical_field ON table(field);
   ```

2. **使用前缀索引（长字符串）**
   ```sql
   -- 对于长文本，只索引前 N 个字符
   CREATE UNIQUE INDEX uk_email_prefix ON users(email(50));
   ```

3. **定期分析和优化索引**
   ```sql
   -- 分析表
   ANALYZE TABLE users;
   
   -- 查看索引使用情况
   SHOW INDEX FROM users;
   ```

4. **选择合适的存储引擎**
   ```sql
   -- InnoDB 支持事务和外键，推荐使用
   CREATE TABLE orders (...) ENGINE=InnoDB;
   ```

### 8.2 处理高并发场景

```csharp
public class HighConcurrencyOrderService
{
    private readonly OrderDbContext _dbContext;
    
    /// <summary>
    /// 使用数据库锁防止超卖
    /// </summary>
    public async Task<Result> CreateOrderWithLockAsync(CreateOrderRequest request)
    {
        using var transaction = await _dbContext.Database.BeginTransactionAsync(
            IsolationLevel.Serializable); // 最高隔离级别
        
        try
        {
            // 锁定库存记录
            var product = await _dbContext.Products
                .FromSqlRaw("SELECT * FROM products WHERE id = @ProductId FOR UPDATE", 
                    new SqlParameter("@ProductId", request.ProductId))
                .FirstOrDefaultAsync();
            
            if (product.Stock < request.Quantity)
            {
                return Result.Fail("Insufficient stock");
            }
            
            // 扣减库存
            product.Stock -= request.Quantity;
            await _dbContext.SaveChangesAsync();
            
            // 创建订单
            var order = new Order { /* ... */ };
            _dbContext.Orders.Add(order);
            await _dbContext.SaveChangesAsync();
            
            await transaction.CommitAsync();
            return Result.Success();
        }
        catch
        {
            await transaction.RollbackAsync();
            throw;
        }
    }
}
```

### 8.3 监控唯一索引冲突

```csharp
public class DatabaseMetricsCollector
{
    private readonly IMetricsCollector _metrics;
    private readonly AppDbContext _dbContext;
    
    public async Task CollectUniqueConstraintViolationsAsync()
    {
        var sql = @"
            SELECT VARIABLE_VALUE 
            FROM information_schema.GLOBAL_STATUS 
            WHERE VARIABLE_NAME = 'Innodb_row_lock_timeouts'";
        
        var timeouts = await _dbContext.Database.SqlQueryRaw<long>(sql).FirstOrDefaultAsync();
        
        _metrics.RecordGauge("db.unique_constraint_violations", timeouts);
    }
}
```

### 8.4 常见陷阱及解决方案

#### 陷阱1：NULL 值处理

```sql
-- MySQL 中，多个 NULL 不算重复
INSERT INTO users (email) VALUES (NULL); -- 成功
INSERT INTO users (email) VALUES (NULL); -- 也成功！

-- 如果需要一个非空唯一约束
ALTER TABLE users MODIFY email VARCHAR(100) NOT NULL;
CREATE UNIQUE INDEX uk_email ON users(email);
```

#### 陷阱2：字符集和排序规则

```sql
-- utf8mb4_general_ci 不区分大小写
INSERT INTO users (email) VALUES ('John@Example.com');
INSERT INTO users (email) VALUES ('john@example.com'); -- 失败：重复

-- 如果需要区分大小写
CREATE UNIQUE INDEX uk_email_cs ON users(email) COLLATE utf8mb4_bin;
```

#### 陷阱3：自增 ID 间隙

```sql
-- REPLACE INTO 会导致自增 ID 变化
REPLACE INTO users (email, username) VALUES ('john@example.com', 'john');
-- 旧记录的 ID 被删除，新记录获得新的 ID

-- 解决方案：使用 ON DUPLICATE KEY UPDATE
INSERT INTO users (email, username) VALUES ('john@example.com', 'john')
ON DUPLICATE KEY UPDATE username = VALUES(username);
```

---

## 总结

MySQL 唯一索引是实现幂等性的**最简单、最可靠**的方式：

### 核心要点

1. **单列唯一索引**：适用于单一字段唯一性（邮箱、用户名）
2. **复合唯一索引**：适用于多字段组合唯一（订单+商品）
3. **部分唯一索引**：MySQL 8.0.13+ 支持条件唯一
4. **UPSERT 操作**：`ON DUPLICATE KEY UPDATE` 实现插入或更新
5. **异常处理**：捕获 `MySqlException Number=1062` 处理冲突

### 性能建议

- 唯一索引会影响写入性能，控制在必要数量
- 长字符串使用前缀索引
- 高并发场景配合数据库锁使用
- 定期监控和分析索引性能

通过合理使用唯一索引，可以在数据库层面保证数据唯一性，实现简单高效的幂等性控制。
