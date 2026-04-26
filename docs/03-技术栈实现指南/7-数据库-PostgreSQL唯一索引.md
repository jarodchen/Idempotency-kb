---
editLink: true
lastUpdated: true
---
# 数据库 - PostgreSQL 唯一索引详解

## 概述

PostgreSQL 提供了强大的唯一索引功能，是实现幂等性的核心机制之一。本文深入讲解 PostgreSQL 唯一索引的各种用法和最佳实践。

## 基础唯一索引

### 1. 创建表时定义

```sql
-- 方式 1: 列级约束
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL UNIQUE,  -- 列级唯一约束
    username VARCHAR(50) NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 方式 2: 表级约束
CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sku VARCHAR(50) NOT NULL,
    name VARCHAR(100) NOT NULL,
    
    CONSTRAINT uk_products_sku UNIQUE (sku)  -- 表级唯一约束
);
```

### 2. 单独创建唯一索引

```sql
-- 基本语法
CREATE UNIQUE INDEX idx_users_email ON users(email);

-- 指定索引方法（默认 B-tree）
CREATE UNIQUE INDEX idx_users_email ON users USING btree(email);

-- 多列唯一索引
CREATE UNIQUE INDEX idx_orders_user_number 
ON orders(user_id, order_number);
```

## 高级唯一索引

### 1. 部分唯一索引（Partial Unique Index）

PostgreSQL 特有的强大功能，只对满足条件的行建立唯一约束：

```sql
-- 只保证活跃用户的邮箱唯一
CREATE UNIQUE INDEX idx_users_email_active 
ON users(email) 
WHERE is_active = true;

-- 允许同一个邮箱有多个账户，但只有一个可以是活跃的
INSERT INTO users (email, is_active) VALUES ('test@example.com', true);   -- ✓ 成功
INSERT INTO users (email, is_active) VALUES ('test@example.com', false);  -- ✓ 成功
INSERT INTO users (email, is_active) VALUES ('test@example.com', true);   -- ✗ 失败

-- 订单状态的部分唯一索引
CREATE UNIQUE INDEX idx_orders_pending_per_user
ON orders(user_id)
WHERE status = 'pending';

-- 每个用户只能有一个待支付订单
```

### 2. 表达式唯一索引

基于表达式的结果建立唯一索引：

```sql
-- 邮箱大小写不敏感的唯一索引
CREATE UNIQUE INDEX idx_users_email_lower 
ON users(LOWER(email));

-- 测试
INSERT INTO users (email) VALUES ('User@Example.COM');  -- ✓ 成功
INSERT INTO users (email) VALUES ('user@example.com');  -- ✗ 失败（冲突）

-- 去除空格的电话号码
CREATE UNIQUE INDEX idx_users_phone_trimmed 
ON users(TRIM(phone));

-- 组合表达式
CREATE UNIQUE INDEX idx_products_normalized_name
ON products(LOWER(TRIM(name)));
```

### 3. NULLS NOT DISTINCT（PostgreSQL 15+）

PostgreSQL 15 引入的新特性，允许将 NULL 视为相同值：

```sql
-- PostgreSQL 15+
CREATE UNIQUE INDEX idx_users_referral_code 
ON users(referral_code) 
NULLS NOT DISTINCT;

-- 测试
INSERT INTO users (referral_code) VALUES (NULL);  -- ✓ 第一个 NULL
INSERT INTO users (referral_code) VALUES (NULL);  -- ✗ 第二个 NULL（冲突）

-- 旧版本 workaround：使用部分索引
CREATE UNIQUE INDEX idx_users_referral_code_not_null 
ON users(referral_code) 
WHERE referral_code IS NOT NULL;
```

## Entity Framework Core 配置

### 1. Fluent API 配置

```csharp
using Microsoft.EntityFrameworkCore;

public class AppDbContext : DbContext
{
    public DbSet<User> Users { get; set; }
    public DbSet<Product> Products { get; set; }
    public DbSet<Order> Orders { get; set; }
    
    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        // 单字段唯一索引
        modelBuilder.Entity<User>()
            .HasIndex(u => u.Email)
            .IsUnique()
            .HasDatabaseName("idx_users_email");
        
        // 多字段唯一索引
        modelBuilder.Entity<Order>()
            .HasIndex(o => new { o.UserId, o.OrderNumber })
            .IsUnique()
            .HasDatabaseName("idx_orders_user_number");
        
        // 部分唯一索引（需要 raw SQL）
        modelBuilder.Entity<User>()
            .HasIndex(u => u.Email)
            .HasFilter("is_active = true")
            .IsUnique()
            .HasDatabaseName("idx_users_email_active");
        
        // 表达式唯一索引（需要 raw SQL）
        modelBuilder.Entity<User>()
            .HasIndex(u => u.Email)
            .HasMethod("btree")
            .IsUnique();
        
        // 在迁移后执行自定义 SQL
        modelBuilder.HasPostgresExtension("citext"); // 大小写不敏感文本
    }
}
```

### 2. 数据注解

```csharp
using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

public class User
{
    public Guid Id { get; set; }
    
    [Required]
    [MaxLength(255)]
    [EmailAddress]
    public string Email { get; set; }
    
    [Required]
    [MaxLength(50)]
    public string Username { get; set; }
}

// 注意：数据注解不支持部分索引和表达式索引
// 需要使用 Fluent API 或 raw SQL
```

## UPSERT 操作

### 1. INSERT ... ON CONFLICT

PostgreSQL 的 UPSERT 语法：

```sql
-- 基本语法：冲突时什么都不做
INSERT INTO users (id, email, username)
VALUES (gen_random_uuid(), 'test@example.com', 'testuser')
ON CONFLICT (email) 
DO NOTHING;

-- 冲突时更新某些字段
INSERT INTO users (id, email, username, updated_at)
VALUES (gen_random_uuid(), 'test@example.com', 'testuser', NOW())
ON CONFLICT (email) 
DO UPDATE SET 
    username = EXCLUDED.username,
    updated_at = NOW();

-- 使用条件
INSERT INTO users (id, email, status)
VALUES (gen_random_uuid(), 'test@example.com', 'active')
ON CONFLICT (email) 
DO UPDATE SET 
    status = EXCLUDED.status
WHERE users.status != 'deleted';  -- 只有非删除状态才更新
```

### 2. C# 实现

```csharp
public class UserRepository
{
    private readonly AppDbContext _dbContext;
    
    /// <summary>
    /// 使用 UPSERT 创建或更新用户
    /// </summary>
    public async Task<User> UpsertUserAsync(User user)
    {
        const string sql = @"
            INSERT INTO users (id, email, username, created_at, updated_at)
            VALUES (@id, @email, @username, @createdAt, @updatedAt)
            ON CONFLICT (email) 
            DO UPDATE SET 
                username = EXCLUDED.username,
                updated_at = EXCLUDED.updated_at
            RETURNING *";
        
        await using var command = _dbContext.Database.GetDbConnection().CreateCommand();
        command.CommandText = sql;
        
        command.Parameters.AddWithValue("@id", user.Id);
        command.Parameters.AddWithValue("@email", user.Email);
        command.Parameters.AddWithValue("@username", user.Username);
        command.Parameters.AddWithValue("@createdAt", user.CreatedAt);
        command.Parameters.AddWithValue("@updatedAt", user.UpdatedAt);
        
        await _dbContext.Database.OpenConnectionAsync();
        
        await using var reader = await command.ExecuteReaderAsync();
        
        if (await reader.ReadAsync())
        {
            return MapUser(reader);
        }
        
        throw new Exception("Failed to upsert user");
    }
    
    /// <summary>
    /// 批量 UPSERT
    /// </summary>
    public async Task<int> BulkUpsertUsersAsync(List<User> users)
    {
        using var transaction = await _dbContext.Database.BeginTransactionAsync();
        
        try
        {
            int affectedRows = 0;
            
            foreach (var user in users)
            {
                var sql = @"
                    INSERT INTO users (id, email, username, created_at, updated_at)
                    VALUES (@id, @email, @username, @createdAt, @updatedAt)
                    ON CONFLICT (email) 
                    DO UPDATE SET 
                        username = EXCLUDED.username,
                        updated_at = EXCLUDED.updated_at";
                
                affectedRows += await _dbContext.Database.ExecuteSqlRawAsync(sql,
                    new NpgsqlParameter("@id", user.Id),
                    new NpgsqlParameter("@email", user.Email),
                    new NpgsqlParameter("@username", user.Username),
                    new NpgsqlParameter("@createdAt", user.CreatedAt),
                    new NpgsqlParameter("@updatedAt", user.UpdatedAt));
            }
            
            await transaction.CommitAsync();
            
            return affectedRows;
        }
        catch
        {
            await transaction.RollbackAsync();
            throw;
        }
    }
}
```

## 性能优化

### 1. 索引监控

```sql
-- 查看索引使用情况
SELECT 
    schemaname,
    tablename,
    indexname,
    idx_scan,           -- 索引扫描次数
    idx_tup_read,       -- 读取的元组数
    idx_tup_fetch       -- 获取的元组数
FROM pg_stat_user_indexes
WHERE indexname LIKE 'idx_%'
ORDER BY idx_scan DESC;

-- 查看未使用的索引
SELECT 
    schemaname,
    tablename,
    indexname,
    idx_scan
FROM pg_stat_user_indexes
WHERE idx_scan = 0
  AND indexname LIKE 'idx_%';

-- 查看索引大小
SELECT 
    indexname,
    pg_size_pretty(pg_relation_size(indexname::text)) AS index_size
FROM pg_indexes
WHERE tablename = 'users'
  AND indexname LIKE 'idx_%';
```

### 2. 重建索引

```sql
-- 重建单个索引
REINDEX INDEX idx_users_email;

-- 重建表的所有索引
REINDEX TABLE users;

-- 并发重建（不阻塞读写，PostgreSQL 12+）
REINDEX INDEX CONCURRENTLY idx_users_email;

-- 定期重建碎片化的索引
-- 当索引膨胀超过 30% 时重建
SELECT 
    indexrelname,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
    idx_scan,
    idx_tup_read
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
ORDER BY pg_relation_size(indexrelid) DESC;
```

### 3. 避免索引膨胀

```sql
-- 检查索引膨胀
SELECT 
    schemaname,
    relname AS table_name,
    indexrelname AS index_name,
    idx_scan,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
    CASE 
        WHEN idx_scan = 0 THEN 'UNUSED'
        WHEN pg_relation_size(indexrelid) > 100 * 1024 * 1024 THEN 'LARGE'
        ELSE 'OK'
    END AS status
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
ORDER BY pg_relation_size(indexrelid) DESC;

-- VACUUM 清理死元组
VACUUM ANALYZE users;

-- 完全清理（回收空间，但会锁表）
VACUUM FULL users;
```

## 错误处理

### 1. 捕获唯一约束违反

```csharp
using Npgsql;

public class UserService
{
    private readonly AppDbContext _dbContext;
    private readonly ILogger<UserService> _logger;
    
    public async Task<Result<User>> CreateUserAsync(CreateUserRequest request)
    {
        var user = new User
        {
            Id = Guid.NewGuid(),
            Email = request.Email.ToLowerInvariant(),
            Username = request.Username,
            CreatedAt = DateTime.UtcNow
        };
        
        try
        {
            _dbContext.Users.Add(user);
            await _dbContext.SaveChangesAsync();
            
            return Result<User>.Success(user);
        }
        catch (DbUpdateException ex) when (IsUniqueViolation(ex))
        {
            var constraintName = ExtractConstraintName(ex);
            
            _logger.LogWarning("Unique constraint violation: {Constraint}", constraintName);
            
            if (constraintName.Contains("email"))
            {
                return Result<User>.Failure("Email already registered");
            }
            else if (constraintName.Contains("username"))
            {
                return Result<User>.Failure("Username already taken");
            }
            
            return Result<User>.Failure("Duplicate entry detected");
        }
    }
    
    private bool IsUniqueViolation(DbUpdateException ex)
    {
        return ex.InnerException is PostgresException pgEx 
            && pgEx.SqlState == "23505"; // unique_violation
    }
    
    private string ExtractConstraintName(DbUpdateException ex)
    {
        if (ex.InnerException is PostgresException pgEx)
        {
            return pgEx.ConstraintName ?? "";
        }
        return "";
    }
}
```

### 2. PostgreSQL 错误码

```csharp
public static class PostgresErrorCodes
{
    public const string UniqueViolation = "23505";
    public const string ForeignKeyViolation = "23503";
    public const string NotNullViolation = "23502";
    public const string CheckViolation = "23514";
}

// 使用
catch (DbUpdateException ex) when (ex.InnerException is PostgresException pgEx)
{
    switch (pgEx.SqlState)
    {
        case PostgresErrorCodes.UniqueViolation:
            // 处理唯一约束违反
            break;
        case PostgresErrorCodes.ForeignKeyViolation:
            // 处理外键约束违反
            break;
        default:
            throw;
    }
}
```

## 最佳实践总结

### ✅ DO

1. **选择合适的字段**：只对真正需要唯一的字段建立索引
2. **使用部分索引**：减少索引大小，提高性能
3. **定期监控**：检查索引使用情况和膨胀
4. **命名规范**：使用 `idx_table_column` 格式
5. **考虑大小写**：使用 LOWER() 或 citext 扩展

### ❌ DON'T

1. **不要过度索引**：每个索引都会降低写入性能
2. **不要忽略 NULL**：理解 NULL 在唯一索引中的行为
3. **不要忘记维护**：定期 VACUUM 和 REINDEX
4. **不要假设顺序**：多列索引的顺序很重要

## 总结

PostgreSQL 唯一索引是实现幂等性的强大工具：

✅ **功能丰富**：部分索引、表达式索引、UPSERT  
✅ **性能优秀**：B-tree 索引高效可靠  
✅ **灵活配置**：支持多种场景  
✅ **易于监控**：丰富的系统视图  

通过合理使用唯一索引，可以在数据库层面保证数据的唯一性，实现强一致性的幂等控制。
