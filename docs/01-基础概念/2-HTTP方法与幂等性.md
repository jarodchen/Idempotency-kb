---
editLink: true
lastUpdated: true
---
# HTTP 方法与幂等性

## HTTP 方法的幂等性分类

HTTP/1.1 规范（RFC 7231）明确定义了各个 HTTP 方法的幂等性特性。理解这些特性对于设计 RESTful API 至关重要。

## 安全方法（Safe Methods）

安全方法是指不会修改服务器资源的方法，它们天然是幂等的。

### GET - 获取资源

**特性**：安全、幂等

```csharp
// ✅ GET 请求天然幂等
[HttpGet("{id}")]
public async Task<ActionResult<Product>> GetProduct(Guid id)
{
    var product = await _dbContext.Products.FindAsync(id);
    return Ok(product);
}

// 多次调用返回相同结果（假设数据未被其他操作修改）
// GET /api/products/123
// GET /api/products/123
// GET /api/products/123
```

### HEAD - 获取资源元数据

**特性**：安全、幂等

```csharp
[HttpHead("{id}")]
public async Task<IActionResult> HeadProduct(Guid id)
{
    var product = await _dbContext.Products.FindAsync(id);
    
    if (product == null)
        return NotFound();
    
    Response.Headers["Content-Length"] = "0";
    Response.Headers["Last-Modified"] = product.UpdatedAt.ToString("R");
    
    return Ok();
}
```

### OPTIONS - 获取支持的 HTTP 方法

**特性**：安全、幂等

```csharp
[HttpOptions]
public IActionResult OptionsProducts()
{
    Response.Headers["Allow"] = "GET, POST, PUT, DELETE, OPTIONS";
    return Ok();
}
```

## 幂等方法（Idempotent Methods）

这些方法可能会修改服务器资源，但重复执行不会产生额外的副作用。

### PUT - 替换资源

**特性**：不安全、幂等

PUT 方法是典型的幂等方法，因为它使用**覆盖语义**：

```csharp
// ✅ PUT 是幂等的：多次更新到相同状态
[HttpPut("{id}")]
public async Task<IActionResult> UpdateProduct(Guid id, UpdateProductRequest request)
{
    var product = await _dbContext.Products.FindAsync(id);
    if (product == null)
        return NotFound();
    
    // 覆盖式更新
    product.Name = request.Name;
    product.Price = request.Price;
    product.UpdatedAt = DateTime.UtcNow;
    
    await _dbContext.SaveChangesAsync();
    return NoContent();
}

// 以下三次请求效果相同：
// PUT /api/products/123 { "name": "iPhone", "price": 999 }
// PUT /api/products/123 { "name": "iPhone", "price": 999 }
// PUT /api/products/123 { "name": "iPhone", "price": 999 }
```

**为什么 PUT 是幂等的？**
- 第一次请求：将资源状态从 A 改为 B
- 第二次请求：将资源状态从 B 改为 B（无变化）
- 第 N 次请求：将资源状态从 B 改为 B（无变化）

### DELETE - 删除资源

**特性**：不安全、幂等

DELETE 方法也是幂等的，因为删除一个不存在的资源仍然是"已删除"状态：

```csharp
// ✅ DELETE 是幂等的
[HttpDelete("{id}")]
public async Task<IActionResult> DeleteProduct(Guid id)
{
    var product = await _dbContext.Products.FindAsync(id);
    
    if (product == null)
    {
        // 资源不存在也视为成功（可能已被删除）
        return NoContent();
    }
    
    _dbContext.Products.Remove(product);
    await _dbContext.SaveChangesAsync();
    
    return NoContent();
}

// 以下三次请求效果相同：
// DELETE /api/products/123 -> 204 No Content（删除成功）
// DELETE /api/products/123 -> 204 No Content（已经删除）
// DELETE /api/products/123 -> 204 No Content（已经删除）
```

**最佳实践**：即使资源不存在，DELETE 也应返回成功状态码（204 或 404），而不是错误。

## 非幂等方法（Non-Idempotent Methods）

这些方法每次调用都可能产生不同的结果或副作用。

### POST - 创建资源或触发动作

**特性**：不安全、**非幂等**

POST 是最常见的非幂等方法，因为它通常用于**创建新资源**：

```csharp
// ❌ POST 是非幂等的：每次调用都会创建新资源
[HttpPost]
public async Task<ActionResult<Order>> CreateOrder(CreateOrderRequest request)
{
    var order = new Order
    {
        Id = Guid.NewGuid(), // 每次生成不同的 ID
        UserId = request.UserId,
        Amount = request.Amount,
        CreatedAt = DateTime.UtcNow
    };
    
    _dbContext.Orders.Add(order);
    await _dbContext.SaveChangesAsync();
    
    return CreatedAtAction(nameof(GetOrder), new { id = order.Id }, order);
}

// 以下三次请求会创建三个不同的订单：
// POST /api/orders { "userId": 1, "amount": 100 } -> Order #1
// POST /api/orders { "userId": 1, "amount": 100 } -> Order #2
// POST /api/orders { "userId": 1, "amount": 100 } -> Order #3
```

**如何让 POST 变得幂等？**

通过引入**幂等键（Idempotency Key）**：

```csharp
// ✅ 使用幂等键使 POST 变得幂等
[HttpPost]
public async Task<ActionResult<Order>> CreateOrder(
    CreateOrderRequest request,
    [FromHeader(Name = "Idempotency-Key")] string idempotencyKey)
{
    if (string.IsNullOrEmpty(idempotencyKey))
    {
        return BadRequest("Idempotency-Key header is required");
    }
    
    // 检查是否已存在相同的幂等键
    var existingOrder = await _dbContext.Orders
        .FirstOrDefaultAsync(o => o.IdempotencyKey == idempotencyKey);
    
    if (existingOrder != null)
    {
        // 返回已创建的订单（幂等行为）
        return Ok(existingOrder);
    }
    
    // 创建新订单
    var order = new Order
    {
        Id = Guid.NewGuid(),
        IdempotencyKey = idempotencyKey, // 存储幂等键
        UserId = request.UserId,
        Amount = request.Amount,
        CreatedAt = DateTime.UtcNow
    };
    
    _dbContext.Orders.Add(order);
    await _dbContext.SaveChangesAsync();
    
    return CreatedAtAction(nameof(GetOrder), new { id = order.Id }, order);
}

// 以下三次请求只会创建一个订单：
// POST /api/orders (Idempotency-Key: abc-123) { "userId": 1, "amount": 100 } -> Order #1
// POST /api/orders (Idempotency-Key: abc-123) { "userId": 1, "amount": 100 } -> Order #1 (返回已存在的)
// POST /api/orders (Idempotency-Key: abc-123) { "userId": 1, "amount": 100 } -> Order #1 (返回已存在的)
```

### PATCH - 部分更新资源

**特性**：不安全、**通常非幂等**

PATCH 方法的幂等性取决于具体的实现方式：

#### 非幂等的 PATCH 示例

```csharp
// ❌ 非幂等的 PATCH：累加操作
[HttpPatch("{id}/balance")]
public async Task<IActionResult> AddToBalance(Guid id, decimal amount)
{
    var account = await _dbContext.Accounts.FindAsync(id);
    if (account == null)
        return NotFound();
    
    // 累加操作 - 非幂等
    account.Balance += amount;
    await _dbContext.SaveChangesAsync();
    
    return Ok(account);
}

// 以下三次请求会产生不同结果：
// PATCH /api/accounts/123/balance { "amount": 10 } -> Balance: 10
// PATCH /api/accounts/123/balance { "amount": 10 } -> Balance: 20
// PATCH /api/accounts/123/balance { "amount": 10 } -> Balance: 30
```

#### 幂等的 PATCH 示例

```csharp
// ✅ 幂等的 PATCH：设置操作
[HttpPatch("{id}")]
public async Task<IActionResult> UpdateProductFields(
    Guid id, 
    JsonDocument patchDocument)
{
    var product = await _dbContext.Products.FindAsync(id);
    if (product == null)
        return NotFound();
    
    // 解析 JSON Patch
    var root = patchDocument.RootElement;
    
    if (root.TryGetProperty("name", out var nameElement))
    {
        product.Name = nameElement.GetString(); // 覆盖式更新 - 幂等
    }
    
    if (root.TryGetProperty("price", out var priceElement))
    {
        product.Price = priceElement.GetDecimal(); // 覆盖式更新 - 幂等
    }
    
    product.UpdatedAt = DateTime.UtcNow;
    await _dbContext.SaveChangesAsync();
    
    return NoContent();
}

// 以下三次请求效果相同：
// PATCH /api/products/123 { "name": "iPhone", "price": 999 }
// PATCH /api/products/123 { "name": "iPhone", "price": 999 }
// PATCH /api/products/123 { "name": "iPhone", "price": 999 }
```

## 幂等性对比表

| HTTP 方法 | 安全性 | 幂等性 | 典型用途 | 是否需要幂等设计 |
|----------|--------|--------|---------|----------------|
| GET | ✅ 安全 | ✅ 幂等 | 查询资源 | ❌ 不需要 |
| HEAD | ✅ 安全 | ✅ 幂等 | 查询元数据 | ❌ 不需要 |
| OPTIONS | ✅ 安全 | ✅ 幂等 | 查询支持的方法 | ❌ 不需要 |
| PUT | ❌ 不安全 | ✅ 幂等 | 替换资源 | ❌ 天然幂等 |
| DELETE | ❌ 不安全 | ✅ 幂等 | 删除资源 | ❌ 天然幂等 |
| POST | ❌ 不安全 | ❌ 非幂等 | 创建资源 | ✅ **需要设计** |
| PATCH | ❌ 不安全 | ⚠️ 视情况 | 部分更新 | ⚠️ **可能需要** |

## 实际应用场景

### 场景 1：订单创建（POST + 幂等键）

```csharp
// 客户端代码
public class OrderService
{
    private readonly HttpClient _httpClient;
    
    public async Task<Order> CreateOrderWithIdempotency(OrderRequest request)
    {
        // 生成唯一的幂等键
        var idempotencyKey = $"{request.UserId}_{request.OrderDate:yyyyMMdd}_{request.CartHash}";
        
        var httpRequest = new HttpRequestMessage(HttpMethod.Post, "/api/orders");
        httpRequest.Headers.Add("Idempotency-Key", idempotencyKey);
        httpRequest.Content = JsonContent.Create(request);
        
        var response = await _httpClient.SendAsync(httpRequest);
        response.EnsureSuccessStatusCode();
        
        return await response.Content.ReadFromJsonAsync<Order>();
    }
}

// 服务端代码
[ApiController]
[Route("api/[controller]")]
public class OrdersController : ControllerBase
{
    [HttpPost]
    public async Task<ActionResult<Order>> CreateOrder(
        [FromBody] OrderRequest request,
        [FromHeader(Name = "Idempotency-Key")] string idempotencyKey)
    {
        // 验证幂等键
        if (string.IsNullOrWhiteSpace(idempotencyKey))
        {
            return BadRequest(new { error = "Idempotency-Key header is required" });
        }
        
        // 尝试从缓存中获取已处理的请求
        var cachedOrder = await _cache.GetAsync<Order>($"order:{idempotencyKey}");
        if (cachedOrder != null)
        {
            _logger.LogInformation("命中幂等缓存，返回已有订单: {Key}", idempotencyKey);
            return Ok(cachedOrder);
        }
        
        // 使用数据库事务保证原子性
        using var transaction = await _dbContext.Database.BeginTransactionAsync();
        try
        {
            // 检查数据库中是否已存在
            var existingOrder = await _dbContext.Orders
                .FirstOrDefaultAsync(o => o.IdempotencyKey == idempotencyKey);
            
            if (existingOrder != null)
            {
                await _cache.SetAsync($"order:{idempotencyKey}", existingOrder, TimeSpan.FromHours(24));
                return Ok(existingOrder);
            }
            
            // 创建新订单
            var order = new Order
            {
                Id = Guid.NewGuid(),
                IdempotencyKey = idempotencyKey,
                UserId = request.UserId,
                TotalAmount = request.TotalAmount,
                Status = OrderStatus.Created,
                CreatedAt = DateTime.UtcNow
            };
            
            _dbContext.Orders.Add(order);
            await _dbContext.SaveChangesAsync();
            await transaction.CommitAsync();
            
            // 缓存结果
            await _cache.SetAsync($"order:{idempotencyKey}", order, TimeSpan.FromHours(24));
            
            return CreatedAtAction(nameof(GetOrder), new { id = order.Id }, order);
        }
        catch (Exception ex)
        {
            await transaction.RollbackAsync();
            _logger.LogError(ex, "创建订单失败");
            return StatusCode(500, new { error = "Internal server error" });
        }
    }
}
```

### 场景 2：库存扣减（PATCH + 乐观锁）

```csharp
// 幂等的库存扣减
[HttpPatch("{productId}/inventory/deduct")]
public async Task<IActionResult> DeductInventory(
    Guid productId, 
    [FromBody] DeductInventoryRequest request)
{
    var product = await _dbContext.Products
        .FirstOrDefaultAsync(p => p.Id == productId && p.Version == request.Version);
    
    if (product == null)
    {
        return Conflict(new { error = "Product not found or version mismatch" });
    }
    
    if (product.Stock < request.Quantity)
    {
        return BadRequest(new { error = "Insufficient stock" });
    }
    
    // 使用乐观锁保证幂等性
    product.Stock -= request.Quantity;
    product.Version++; // 版本号递增
    product.UpdatedAt = DateTime.UtcNow;
    
    await _dbContext.SaveChangesAsync();
    
    return Ok(new { newStock = product.Stock, newVersion = product.Version });
}

public class DeductInventoryRequest
{
    public int Quantity { get; set; }
    public int Version { get; set; } // 客户端传入当前版本号
}
```

## 最佳实践总结

### 1. 遵循 HTTP 语义

- 使用 GET 进行查询（天然幂等）
- 使用 PUT 进行完整替换（天然幂等）
- 使用 DELETE 进行删除（天然幂等）
- 使用 POST 进行创建（需要额外设计幂等性）

### 2. POST 请求必须支持幂等键

```csharp
// 推荐：强制要求幂等键
[HttpPost]
public async Task<ActionResult<T>> Create(
    [FromBody] T request,
    [FromHeader(Name = "Idempotency-Key")] string idempotencyKey)
{
    if (string.IsNullOrWhiteSpace(idempotencyKey))
    {
        return BadRequest("Idempotency-Key is required for POST requests");
    }
    
    // ... 幂等处理逻辑
}
```

### 3. 为 PATCH 操作设计幂等逻辑

```csharp
// 推荐：使用覆盖而非累加
public async Task UpdateBalance(Guid accountId, decimal newBalance)
{
    // ✅ 幂等：设置为指定值
    account.Balance = newBalance;
    
    // ❌ 非幂等：累加
    // account.Balance += amount;
}
```

### 4. 返回正确的状态码

```csharp
// DELETE 操作：资源不存在也返回成功
if (resource == null)
{
    return NoContent(); // 204，而不是 404
}

// POST 操作：重复请求返回 200 而不是 201
if (existingResource != null)
{
    return Ok(existingResource); // 200，表示返回已存在的资源
}
```

## 总结

理解 HTTP 方法与幂等性的关系是设计健壮 API 的基础：

1. **GET、PUT、DELETE** 天然幂等，无需额外设计
2. **POST** 是非幂等的，必须通过幂等键等机制来实现幂等性
3. **PATCH** 的幂等性取决于具体实现，需要根据业务场景判断
4. 在分布式系统中，即使是幂等的 HTTP 方法也需要考虑并发控制和一致性保障

下一章我们将深入探讨幂等性与安全性的关系。
