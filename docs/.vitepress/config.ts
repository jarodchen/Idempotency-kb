import { defineConfig } from 'vitepress'

export default defineConfig({
  title: '幂等性设计知识库',
  description: '系统化、结构化的幂等性设计技术知识库',
  
  base: '/Idempotency-kb/',
  
  // 主题配置
  themeConfig: {
    logo: '/logo.svg',
    
    // 导航栏
    nav: [
      { text: '首页', link: '/' },
      { text: '基础概念', link: '/01-基础概念/1-什么是幂等性' },
      { text: '核心实现模式', link: '/02-核心实现模式/1-Token机制-基础概念' },
      { text: '技术栈实现指南', link: '/03-技术栈实现指南/1-NET-ASPNETCore中间件' },
      { text: '场景化解决方案', link: '/04-场景化解决方案/1-支付交易-防止重复扣款' },
      { text: '架构与运维', link: '/05-架构与运维/1-API网关-请求指纹识别' },
      { text: '常见问题与陷阱', link: '/06-常见问题与陷阱/1-性能-数据库锁竞争' }
    ],
    
    // 侧边栏
    sidebar: {
    '/01-基础概念/': [
      {
        text: '基础概念',
        collapsed: false,
        items: [
          { text: '什么是幂等性', link: '/01-基础概念/1-什么是幂等性' },
          { text: 'HTTP方法与幂等性', link: '/01-基础概念/2-HTTP方法与幂等性' },
          { text: '幂等性与安全性', link: '/01-基础概念/3-幂等性与安全性' },
          { text: '网络超时与重试机制', link: '/01-基础概念/4-网络超时与重试机制' },
          { text: '前端用户误操作防护', link: '/01-基础概念/5-前端用户误操作防护' },
          { text: '消息队列重复消费', link: '/01-基础概念/6-消息队列重复消费' },
          { text: '分布式系统局部失败', link: '/01-基础概念/7-分布式系统局部失败' }
        ]
      }
    ],
    '/02-核心实现模式/': [
      {
        text: '核心实现模式',
        collapsed: false,
        items: [
          { text: 'Token机制 基础概念', link: '/02-核心实现模式/1-Token机制-基础概念' },
          { text: 'Token机制 预生成模式', link: '/02-核心实现模式/2-Token机制-预生成模式' },
          { text: '唯一索引 异常处理详解', link: '/02-核心实现模式/3-唯一索引-异常处理详解' },
          { text: '唯一索引 数据库约束', link: '/02-核心实现模式/4-唯一索引-数据库约束' },
          { text: '乐观锁 并发冲突处理', link: '/02-核心实现模式/5-乐观锁-并发冲突处理' },
          { text: '乐观锁 版本号机制', link: '/02-核心实现模式/6-乐观锁-版本号机制' },
          { text: '乐观锁 状态机流转控制', link: '/02-核心实现模式/7-乐观锁-状态机流转控制' },
          { text: 'Token机制 同步锁模式', link: '/02-核心实现模式/8-Token机制-同步锁模式' },
          { text: '分布式锁 Redis实现', link: '/02-核心实现模式/8-分布式锁-Redis实现' },
          { text: '全局唯一ID 请求ID去重', link: '/02-核心实现模式/9-全局唯一ID-请求ID去重' }
        ]
      }
    ],
    '/03-技术栈实现指南/': [
      {
        text: '技术栈实现指南',
        collapsed: false,
        items: [
          { text: 'NET ASPNETCore中间件', link: '/03-技术栈实现指南/1-NET-ASPNETCore中间件' },
          { text: 'Redis Lua脚本原子性', link: '/03-技术栈实现指南/10-Redis-Lua脚本原子性' },
          { text: 'NET MinimalAPI幂等性', link: '/03-技术栈实现指南/2-NET-MinimalAPI幂等性' },
          { text: 'NET BackgroundService幂等性', link: '/03-技术栈实现指南/3-NET-BackgroundService幂等性' },
          { text: '数据库 MySQL唯一索引', link: '/03-技术栈实现指南/7-数据库-MySQL唯一索引' },
          { text: '数据库 PostgreSQL唯一索引', link: '/03-技术栈实现指南/7-数据库-PostgreSQL唯一索引' }
        ]
      }
    ],
    '/04-场景化解决方案/': [
      {
        text: '场景化解决方案',
        collapsed: false,
        items: [
          { text: '支付交易 防止重复扣款', link: '/04-场景化解决方案/1-支付交易-防止重复扣款' },
          { text: '支付回调 防止重复扣款', link: '/04-场景化解决方案/2-支付回调-防止重复扣款' },
          { text: '订单系统 防止重复下单', link: '/04-场景化解决方案/3-订单系统-防止重复下单' },
          { text: '用户登录 会话管理', link: '/04-场景化解决方案/4-用户登录-会话管理' },
          { text: '表单提交 用户注册防重', link: '/04-场景化解决方案/7-表单提交-用户注册防重' },
          { text: '库存扣减 高并发幂等', link: '/04-场景化解决方案/8-库存扣减-高并发幂等' }
        ]
      }
    ],
    '/05-架构与运维/': [
      {
        text: '架构与运维',
        collapsed: false,
        items: [
          { text: 'API网关 请求指纹识别', link: '/05-架构与运维/1-API网关-请求指纹识别' },
          { text: 'API网关 限流与去重', link: '/05-架构与运维/1-API网关-限流与去重' },
          { text: 'API网关 请求去重中间件', link: '/05-架构与运维/2-API网关-请求去重中间件' },
          { text: '监控 幂等冲突日志', link: '/05-架构与运维/3-监控-幂等冲突日志' },
          { text: '监控 异常重试告警', link: '/05-架构与运维/4-监控-异常重试告警' },
          { text: '测试 并发压力测试', link: '/05-架构与运维/5-测试-并发压力测试' }
        ]
      }
    ],
    '/06-常见问题与陷阱/': [
      {
        text: '常见问题与陷阱',
        collapsed: false,
        items: [
          { text: '性能 数据库锁竞争', link: '/06-常见问题与陷阱/1-性能-数据库锁竞争' },
          { text: '性能 Redis网络开销', link: '/06-常见问题与陷阱/2-性能-Redis网络开销' },
          { text: '一致性 Token删除原子性', link: '/06-常见问题与陷阱/3-一致性-Token删除原子性' },
          { text: '一致性 分布式事务幂等', link: '/06-常见问题与陷阱/4-一致性-分布式事务幂等' },
          { text: '边界 Token过期处理', link: '/06-常见问题与陷阱/5-边界-Token过期处理' },
          { text: '边界 极端并发穿透', link: '/06-常见问题与陷阱/6-边界-极端并发穿透' }
        ]
      }
    ],
  },
    
    // 搜索
    search: {
      provider: 'local'
    },
    
    // 社交链接
    socialLinks: [
      { icon: 'github', link: 'https://github.com/your-repo/idempotency-kb' }
    ],
    
    // 页脚
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 Idempotency KB'
    },
    
    // 编辑链接
    editLink: {
      pattern: 'https://github.com/your-repo/idempotency-kb/edit/main/Idempotency-kb/:path',
      text: '在 GitHub 上编辑此页'
    },
    
    // 最后更新时间
    lastUpdated: {
      text: '最后更新于',
      formatOptions: {
        dateStyle: 'short',
        timeStyle: 'medium'
      }
    },
    
    // 大纲
    outline: {
      level: [2, 3],
      label: '页面导航'
    }
  },
  
  // Markdown 配置
  markdown: {
    lineNumbers: true,
    
    // 代码高亮主题
    theme: {
      light: 'github-light',
      dark: 'github-dark'
    }
  },
  
  // 忽略死链接（允许引用不存在的文件）
  ignoreDeadLinks: true,
  
  // 头部标签
  head: [
    ['link', { rel: 'icon', href: '/favicon.ico' }],
    ['meta', { name: 'keywords', content: '幂等性, idempotency, C#, .NET, PostgreSQL, Redis' }]
  ]
})
