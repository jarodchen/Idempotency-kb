---
layout: home

hero:
  name: "幂等性设计知识库"
  text: "系统化、结构化的技术知识库"
  tagline: "基于 C#、PostgreSQL、Redis 的完整幂等性实现指南"
  actions:
    - theme: brand
      text: 🚀 快速开始
      link: /01-基础概念/1-什么是幂等性
    - theme: alt
      text: 📖 浏览文档
      link: /导航
    - theme: alt
      text: 🔍 快速参考
      link: /快速参考

features:
  - icon: 🎯
    title: 核心概念
    details: 深入理解幂等性的定义、HTTP方法幂等性、安全性与幂等性的区别
    link: /01-基础概念/1-什么是幂等性
  
  - icon: 🔐
    title: 实现模式
    details: Token机制、唯一索引、乐观锁、分布式锁等核心实现方案
    link: /02-核心实现模式/1-Token机制-基础概念
  
  - icon: 💻
    title: 技术栈实战
    details: ASP.NET Core、Minimal API、PostgreSQL、MySQL、Redis 完整示例
    link: /03-技术栈实现指南/1-NET-ASPNETCore中间件
  
  - icon: 🎬
    title: 场景方案
    details: 支付交易、订单系统、库存扣减、用户登录等真实业务场景
    link: /04-场景化解决方案/1-支付交易-防止重复扣款
  
  - icon: 🏗️
    title: 架构运维
    details: API网关、监控告警、压力测试等企业级实践
    link: /05-架构与运维/1-API网关-限流与去重
  
  - icon: ⚠️
    title: 避坑指南
    details: 性能优化、一致性保证、边界情况处理等常见问题
    link: /06-常见问题与陷阱/1-性能-数据库锁竞争
---

## 📊 知识库统计

<div class="stats">

| 指标 | 数量 |
|------|------|
| 📚 文档总数 | **49个** |
| 📝 总行数 | **28,000+** |
| 💻 代码示例 | **200+** |
| 🎯 覆盖场景 | **15+** |
| 🛠️ 技术栈 | **.NET/C#, PostgreSQL, MySQL, Redis** |

</div>

## 🎯 适合人群

- ✅ **后端开发工程师**：学习如何在实际项目中实现幂等性
- ✅ **架构师**：了解幂等性设计的最佳实践和架构模式
- ✅ **技术负责人**：建立团队的幂等性开发规范
- ✅ **学习者**：系统化掌握幂等性相关知识体系

## 🌟 特色亮点

### 1️⃣ 内容详尽全面
每个主题都包含理论基础、实现方案、代码示例、最佳实践，确保知识覆盖面广且深入。

### 2️⃣ 代码可运行
所有示例均使用 C# 编写，数据库优先使用 PostgreSQL，代码经过验证可直接运行。

### 3️⃣ 实战导向
提供支付、订单、库存、登录等真实业务场景的完整解决方案，即学即用。

### 4️⃣ 结构化学习
从基础概念到高级应用，循序渐进，配合学习路线图快速上手。

## 📚 学习路径推荐

### 🟢 初学者路径
```
基础概念 → Token机制 → 唯一索引 → 支付回调 → 常见问题
```

### 🔵 进阶路径
```
乐观锁 → 分布式锁 → Minimal API → 库存扣减 → 架构运维
```

### 🔴 专家路径
```
状态机 → BackgroundService → API网关 → 性能优化 → 极端并发
```

## 🤝 贡献指南

欢迎提交 Issue 和 Pull Request 来完善这个知识库！

- 🐛 发现错误？[提交 Issue](https://github.com/your-repo/idempotency-kb/issues)
- ✏️ 改进内容？[提交 PR](https://github.com/your-repo/idempotency-kb/pulls)
- 💡 建议新功能？[发起讨论](https://github.com/your-repo/idempotency-kb/discussions)

## 🔗 相关链接

- [🏠 返回主站](https://jarodchen.github.io/)
- [📚 所有知识库](https://jarodchen.github.io/knowledge-base)
- [💼 项目列表](https://jarodchen.github.io/projects)

## 📄 许可证

MIT License - 自由使用、修改和分发
