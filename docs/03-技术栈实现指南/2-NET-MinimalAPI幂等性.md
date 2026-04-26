---
editLink: true
lastUpdated: true
---
# .NET - Minimal API 幂等性实现

## 目录
- [1. 概述](#1-概述)
- [2. Minimal API 基础](#2-minimal-api-基础)
- [3. 基于中间件的幂等性](#3-基于中间件的幂等性)
- [4. 基于 Endpoint Filter 的幂等性](#4-基于-endpoint-filter-的幂等性)
- [5. 完整示例：订单API](#5-完整示例订单api)
- [6. 最佳实践](#6-最佳实践)

---

## 1. 概述

### 1.1 为什么使用 Minimal API？

Minimal API 是 .NET 6+ 推出的轻量级 API 开发模式，相比传统 Controller：

**优势**：
- ✅ **代码更简洁**：减少样板代码
- ✅ **性能更好**：更少的抽象层
- ✅ **启动更快**：更少的反射操作
- ✅ **更适合微服务**：轻量、快速

**适用场景**：
- RESTful API
- 微服务
- Serverless 函数
- 原型开发

### 1.2 幂等性实现方案

在 Minimal API 中，有两种主要方式实现幂等性：

1. **中间件（Middleware）**：全局或路由级别
2. **Endpoint Filter**：针对特定端点（.NET 7+）

---

## 2. Minimal API 基础

### 2.1 基础示例

```csharp
// Program.cs
var builder = WebApplication.CreateBuilder(args);

// 添加服务
builder.Services.AddDbContext<OrderDbContext>(options =>
    options.UseNpgsql(builder.Configuration.GetConnectionString("Default")));

builder.Services.AddStackExchangeRedisCache(options =>
{
    options.Configuration = builder.Configuration.GetConnectionString("Redis");
});

var app = builder.Build();

// 定义端点
app.MapGet("/api/orders/{id}", async (Guid id, OrderDbContext db) =>
{
    var order = await db.Orders.FindAsync(id);
    return order is not null ? Results.Ok(order) : Results.NotFound();
});

app.MapPost("/api/orders", async (CreateOrderRequest request, OrderDbContext db) =>
{
    var order = new Order
    {
        Id = Guid.NewGuid(),
        UserId = request.UserId,
        TotalAmount = request.TotalAmount,
        CreatedAt = DateTime.UtcNow
    };
    
    db.Orders.Add(order);
    await db.SaveChangesAsync();
    
    return Results.Created($"/api/orders/{order.Id}", order);
});

app.Run();

public record CreateOrderRequest(Guid UserId, decimal TotalAmount);
```

---

## 3. 基于中间件的幂等性

### 3.1 请求ID去重中间件

```csharp
namespace Idempotency.MinimalApi.Middleware
{
    public class RequestIdempotencyMiddleware
    {
        private readonly RequestDelegate _next;
        private readonly IDatabase _redis;
        private readonly ILogger<RequestIdempotencyMiddleware> _logger;
        
        public RequestIdempotencyMiddleware(
            RequestDelegate next,
            IConnectionMultiplexer redis,
            ILogger<RequestIdempotencyMiddleware> logger)
        {
            _next = next;
            _redis = redis.GetDatabase();
            _logger = logger;
        }
        
        public async Task InvokeAsync(HttpContext context)
        {
            // 只处理 POST/PUT 请求
            if (!IsIdempotentMethod(context.Request.Method))
            {
                await _next(context);
                return;
            }
            
            // 提取请求ID
            var requestId = ExtractRequestId(context);
            if (string.IsNullOrEmpty(requestId))
            {
                context.Response.StatusCode = StatusCodes.Status400BadRequest;
                await context.Response.WriteAsync("Missing X-Request-ID header");
                return;
            }
            
            // 检查是否重复请求
            var cacheKey = $"idempotency:{requestId}";
            var cachedResponse = await _redis.StringGetAsync(cacheKey);
            
            if (cachedResponse.HasValue)
            {
                _logger.LogDebug("Duplicate request detected: {RequestId}", requestId);
                
                // 返回缓存的响应
                var response = JsonSerializer.Deserialize<CachedResponse>(cachedResponse!);
                if (response != null)
                {
                    context.Response.ContentType = response.ContentType;
                    context.Response.StatusCode = response.StatusCode;
                    await context.Response.WriteAsync(response.Body);
                }
                return;
            }
            
            // 捕获响应
            var originalBodyStream = context.Response.Body;
            using var responseBody = new MemoryStream();
            context.Response.Body = responseBody;
            
            try
            {
                // 继续处理
                await _next(context);
                
                // 读取响应
                responseBody.Seek(0, SeekOrigin.Begin);
                var responseText = await new StreamReader(responseBody).ReadToEndAsync();
                
                // 缓存成功响应
                if (context.Response.StatusCode >= 200 && context.Response.StatusCode < 300)
                {
                    var cachedResponse = new CachedResponse
                    {
                        StatusCode = context.Response.StatusCode,
                        ContentType = context.Response.ContentType,
                        Body = responseText
                    };
                    
                    var json = JsonSerializer.Serialize(cachedResponse);
                    await _redis.StringSetAsync(cacheKey, json, TimeSpan.FromMinutes(10));
                    
                    _logger.LogInformation("Response cached: {RequestId}", requestId);
                }
                
                // 写回响应
                responseBody.Seek(0, SeekOrigin.Begin);
                await responseBody.CopyToAsync(originalBodyStream);
            }
            finally
            {
                context.Response.Body = originalBodyStream;
            }
        }
        
        private bool IsIdempotentMethod(string method)
        {
            return method.Equals("POST", StringComparison.OrdinalIgnoreCase) ||
                   method.Equals("PUT", StringComparison.OrdinalIgnoreCase);
        }
        
        private string? ExtractRequestId(HttpContext context)
        {
            // 优先从 Header 获取
            if (context.Request.Headers.TryGetValue("X-Request-ID", out var requestId))
            {
                return requestId.ToString();
            }
            
            // 从请求体获取（如果是 JSON）
            if (context.Request.ContentType?.Contains("application/json") == true)
            {
                context.Request.EnableBuffering();
                try
                {
                    using var reader = new StreamReader(
                        context.Request.Body, 
                        leaveOpen: true);
                    
                    var body = reader.ReadToEndAsync().GetAwaiter().GetResult();
                    context.Request.Body.Position = 0;
                    
                    using var doc = JsonDocument.Parse(body);
                    if (doc.RootElement.TryGetProperty("requestId", out var idElement))
                    {
                        return idElement.GetString();
                    }
                }
                catch
                {
                    // 忽略解析错误
                }
            }
            
            return null;
        }
    }
    
    public class CachedResponse
    {
        public int StatusCode { get; set; }
        public string ContentType { get; set; } = "application/json";
        public string Body { get; set; } = string.Empty;
    }
}
```

### 3.2 注册中间件

```csharp
// Program.cs
using Idempotency.MinimalApi.Middleware;

var builder = WebApplication.CreateBuilder(args);

// Redis
builder.Services.AddSingleton<IConnectionMultiplexer>(sp =>
{
    var config = builder.Configuration.GetConnectionString("Redis");
    return ConnectionMultiplexer.Connect(config);
});

var app = builder.Build();

// 使用幂等性中间件
app.UseMiddleware<RequestIdempotencyMiddleware>();

// 定义端点...
app.MapPost("/api/orders", HandleCreateOrder);

app.Run();
```

---

## 4. 基于 Endpoint Filter 的幂等性

### 4.1 Token 验证 Filter（.NET 7+）

```csharp
namespace Idempotency.MinimalApi.Filters
{
    public class TokenValidationFilter : IEndpointFilter
    {
        private readonly IDatabase _redis;
        private readonly ILogger<TokenValidationFilter> _logger;
        
        public TokenValidationFilter(
            IConnectionMultiplexer redis,
            ILogger<TokenValidationFilter> logger)
        {
            _redis = redis.GetDatabase();
            _logger = logger;
        }
        
        public async ValueTask<object?> InvokeAsync(
            EndpointFilterInvocationContext context, 
            EndpointFilterDelegate next)
        {
            // 从 Header 提取 Token
            var httpContext = context.HttpContext;
            
            if (!httpContext.Request.Headers.TryGetValue("X-Idempotency-Token", out var tokenHeader))
            {
                return Results.BadRequest(new { error = "Missing X-Idempotency-Token header" });
            }
            
            var token = tokenHeader.ToString();
            
            // 验证并消耗 Token
            var isValid = await ValidateAndConsumeTokenAsync(token);
            
            if (!isValid)
            {
                return Results.Conflict(new { error = "Invalid or expired token" });
            }
            
            // Token 有效，继续处理
            return await next(context);
        }
        
        private async Task<bool> ValidateAndConsumeTokenAsync(string token)
        {
            var key = $"token:{token}";
            var value = await _redis.StringGetDeleteAsync(key);
            return value.HasValue && value == "pending";
        }
    }
}
```

### 4.2 使用 Filter

```csharp
// Program.cs
using Idempotency.MinimalApi.Filters;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSingleton<IConnectionMultiplexer>(sp =>
{
    var config = builder.Configuration.GetConnectionString("Redis");
    return ConnectionMultiplexer.Connect(config);
});

var app = builder.Build();

// 对特定端点应用 Filter
app.MapPost("/api/orders", HandleCreateOrder)
   .AddEndpointFilter<TokenValidationFilter>();

app.MapPost("/api/payments", HandlePayment)
   .AddEndpointFilter<TokenValidationFilter>();

app.Run();

async Task<IResult> HandleCreateOrder(CreateOrderRequest request, OrderDbContext db)
{
    var order = new Order
    {
        Id = Guid.NewGuid(),
        UserId = request.UserId,
        TotalAmount = request.TotalAmount,
        CreatedAt = DateTime.UtcNow
    };
    
    db.Orders.Add(order);
    await db.SaveChangesAsync();
    
    return Results.Created($"/api/orders/{order.Id}", order);
}
```

---

## 5. 完整示例：订单API

### 5.1 项目结构

```
MinimalApiOrderService/
├── Program.cs
├── Endpoints/
│   └── OrderEndpoints.cs
├── Services/
│   ├── IOrderService.cs
│   └── OrderService.cs
├── Models/
│   └── Order.cs
└── DTOs/
    ├── CreateOrderRequest.cs
    └── OrderResponse.cs
```

### 5.2 Program.cs

```csharp
using Microsoft.EntityFrameworkCore;
using StackExchange.Redis;
using MinimalApiOrderService.Endpoints;
using MinimalApiOrderService.Services;

var builder = WebApplication.CreateBuilder(args);

// 数据库
builder.Services.AddDbContext<OrderDbContext>(options =>
    options.UseNpgsql(builder.Configuration.GetConnectionString("Default")));

// Redis
builder.Services.AddSingleton<IConnectionMultiplexer>(sp =>
{
    var config = builder.Configuration.GetConnectionString("Redis");
    return ConnectionMultiplexer.Connect(config);
});

// 服务
builder.Services.AddScoped<IOrderService, OrderService>();

// OpenAPI
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

var app = builder.Build();

// Swagger
if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

// 订单端点
app.MapGroup("/api/orders")
   .MapOrderEndpoints();

app.Run();
```

### 5.3 端点定义

```csharp
namespace MinimalApiOrderService.Endpoints
{
    public static class OrderEndpoints
    {
        public static RouteGroupBuilder MapOrderEndpoints(this RouteGroupBuilder group)
        {
            // 创建订单（带幂等性）
            group.MapPost("/", async (
                CreateOrderRequest request,
                IOrderService orderService,
                HttpContext context) =>
            {
                var result = await orderService.CreateOrderAsync(request);
                
                if (!result.IsSuccess)
                {
                    return Results.BadRequest(result);
                }
                
                return Results.Created($"/api/orders/{result.Data}", result.Data);
            })
            .WithName("CreateOrder")
            .WithOpenApi();
            
            // 查询订单
            group.MapGet("/{id:guid}", async (
                Guid id,
                OrderDbContext db) =>
            {
                var order = await db.Orders.FindAsync(id);
                return order is not null ? Results.Ok(order) : Results.NotFound();
            })
            .WithName("GetOrder")
            .WithOpenApi();
            
            // 取消订单
            group.MapDelete("/{id:guid}", async (
                Guid id,
                IOrderService orderService) =>
            {
                var result = await orderService.CancelOrderAsync(id);
                
                if (!result.IsSuccess)
                {
                    return Results.BadRequest(result);
                }
                
                return Results.NoContent();
            })
            .WithName("CancelOrder")
            .WithOpenApi();
            
            return group;
        }
    }
}
```

### 5.4 订单服务

```csharp
namespace MinimalApiOrderService.Services
{
    public interface IOrderService
    {
        Task<Result<Guid>> CreateOrderAsync(CreateOrderRequest request);
        Task<Result> CancelOrderAsync(Guid orderId);
    }
    
    public class OrderService : IOrderService
    {
        private readonly OrderDbContext _dbContext;
        private readonly ILogger<OrderService> _logger;
        
        public OrderService(OrderDbContext dbContext, ILogger<OrderService> logger)
        {
            _dbContext = dbContext;
            _logger = logger;
        }
        
        public async Task<Result<Guid>> CreateOrderAsync(CreateOrderRequest request)
        {
            try
            {
                var order = new Order
                {
                    Id = Guid.NewGuid(),
                    OrderNo = GenerateOrderNo(),
                    UserId = request.UserId,
                    ProductId = request.ProductId,
                    Quantity = request.Quantity,
                    TotalAmount = request.TotalAmount,
                    Status = OrderStatus.Pending,
                    CreatedAt = DateTime.UtcNow
                };
                
                _dbContext.Orders.Add(order);
                await _dbContext.SaveChangesAsync();
                
                _logger.LogInformation("Order created: {OrderId}", order.Id);
                
                return Result.Success(order.Id);
            }
            catch (DbUpdateException ex) when (IsUniqueViolation(ex))
            {
                _logger.LogWarning("Duplicate order attempt for user {UserId}, product {ProductId}",
                    request.UserId, request.ProductId);
                
                // 返回已存在的订单
                var existingOrder = await _dbContext.Orders
                    .Where(o => o.UserId == request.UserId 
                           && o.ProductId == request.ProductId
                           && o.Status == OrderStatus.Pending)
                    .FirstOrDefaultAsync();
                
                return existingOrder != null 
                    ? Result.Success(existingOrder.Id)
                    : Result.Fail<Guid>("Failed to create order");
            }
        }
        
        public async Task<Result> CancelOrderAsync(Guid orderId)
        {
            var order = await _dbContext.Orders.FindAsync(orderId);
            
            if (order == null)
            {
                return Result.Fail("Order not found");
            }
            
            if (order.Status != OrderStatus.Pending)
            {
                return Result.Fail("Only pending orders can be cancelled");
            }
            
            order.Status = OrderStatus.Cancelled;
            order.CancelledAt = DateTime.UtcNow;
            
            await _dbContext.SaveChangesAsync();
            
            return Result.Success();
        }
        
        private bool IsUniqueViolation(DbUpdateException ex)
        {
            return ex.InnerException is NpgsqlException npgEx && npgEx.SqlState == "23505";
        }
        
        private string GenerateOrderNo()
        {
            return $"ORD{DateTime.UtcNow:yyyyMMddHHmmss}{Guid.NewGuid():N[..8]}";
        }
    }
}
```

---

## 6. 最佳实践

### 6.1 组织端点代码

```csharp
// ✅ 推荐：按功能分组
app.MapGroup("/api/orders")
   .WithTags("Orders")
   .MapOrderEndpoints();

app.MapGroup("/api/payments")
   .WithTags("Payments")
   .MapPaymentEndpoints();

// ❌ 避免：所有端点写在一起
app.MapPost("/api/orders", ...);
app.MapGet("/api/orders/{id}", ...);
app.MapPost("/api/payments", ...);
```

### 6.2 使用依赖注入

```csharp
// ✅ 推荐：注入服务
app.MapPost("/api/orders", async (
    CreateOrderRequest request,
    IOrderService orderService) =>
{
    return await orderService.CreateOrderAsync(request);
});

// ❌ 避免：直接使用 DbContext
app.MapPost("/api/orders", async (
    CreateOrderRequest request,
    OrderDbContext db) =>
{
    // 业务逻辑混在端点中
});
```

### 6.3 统一错误处理

```csharp
// 全局异常处理中间件
app.UseExceptionHandler(async context =>
{
    var exceptionHandlerPathFeature = 
        context.Features.Get<IExceptionHandlerPathFeature>();
    
    var exception = exceptionHandlerPathFeature?.Error;
    
    context.Response.StatusCode = exception switch
    {
        BusinessRuleViolationException => StatusCodes.Status409Conflict,
        ValidationException => StatusCodes.Status400BadRequest,
        NotFoundException => StatusCodes.Status404NotFound,
        _ => StatusCodes.Status500InternalServerError
    };
    
    context.Response.ContentType = "application/json";
    
    var error = new { error = exception?.Message };
    await context.Response.WriteAsJsonAsync(error);
});
```

### 6.4 性能优化

```csharp
// 启用响应压缩
app.UseResponseCompression();

// 使用输出缓存（.NET 7+）
app.MapGet("/api/products/{id}", async (Guid id, OrderDbContext db) =>
{
    return await db.Products.FindAsync(id);
})
.WithOutputCache(options =>
{
    options.Expire(TimeSpan.FromMinutes(5));
});
```

---

## 总结

Minimal API 提供了简洁高效的方式实现幂等性：

### 核心要点

1. **中间件**：适合全局幂等性控制
2. **Endpoint Filter**：适合特定端点的细粒度控制
3. **服务层**：业务逻辑封装，便于测试
4. **依赖注入**：保持代码清晰

### 最佳实践

- 使用 Endpoint Filter 实现 Token 验证
- 使用中间件实现请求ID去重
- 将业务逻辑放在服务层
- 使用 `RouteGroupBuilder` 组织端点

Minimal API + 幂等性设计 = 简洁、高性能的 API 服务 🚀
