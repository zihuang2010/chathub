# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-04-29

### Added

- 项目脚手架：Tauri 2 + React 19 + TypeScript 5.8 + Vite 7。
- Tailwind CSS v3 主题（HSL 变量，明/暗双套）以及 shadcn/ui 经典栈
  （`@radix-ui/react-slot` + `class-variance-authority` + `tailwind-merge` + `tailwindcss-animate`）。
- Rust 端 `tracing` 日志：控制台 + 按天滚动文件输出，文件路径取
  Tauri `app_log_dir`，过滤器走 `CHATHUB_LOG` 环境变量。
- 代码风格工具链：Prettier 3、ESLint 10 (flat config)、`rustfmt.toml`、`clippy.toml`。
- Husky + lint-staged 提交钩子：暂存的前端文件自动 `prettier --write` /
  `eslint --fix`，`backends/**/*.rs` 自动 `rustfmt`。
- 目录结构：前端源码移至 `frontends/`，Rust 端移至 `backends/`。
- `docs/` 目录用于存放架构与开发文档。

[Unreleased]: ../../compare/v0.1.0...HEAD
[0.1.0]: ../../releases/tag/v0.1.0
