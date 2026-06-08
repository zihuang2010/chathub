fn main() {
    // 编译期把 CHATHUB_ATTACHMENT_BASE_URL env 注入为两个常量:
    //   - CHATHUB_ATTACHMENT_BASE_URL_RESOLVED:完整基地址(去尾斜杠),拼附件预览 URL 用;
    //   - CHATHUB_ATTACHMENT_HOST_RESOLVED:取其 host,供 image_cache.rs 的 SSRF 白名单用。
    // 没设 env 时回落到 filet.jdd51.com(与历史硬编码一致);release 缺失时告警,
    // 避免发出去的包拼错附件域。机制与 chathub-net/build.rs 注入 RELAY_URL 同构。
    println!("cargo:rerun-if-env-changed=CHATHUB_ATTACHMENT_BASE_URL");
    println!("cargo:rerun-if-env-changed=PROFILE");

    // 空串也当未设(构建脚本可能 export 空串);否则 host 解析为空 → SSRF 白名单含空项、
    // 附件域一律被拒。filter 掉空白即回落真实默认值。
    let base = std::env::var("CHATHUB_ATTACHMENT_BASE_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            if std::env::var("PROFILE").as_deref() == Ok("release") {
                println!("cargo:warning=CHATHUB_ATTACHMENT_BASE_URL not set; falling back to https://filet.jdd51.com (placeholder)");
            }
            "https://filet.jdd51.com".to_string()
        });
    let base = base.trim_end_matches('/').to_string();
    // 取 host:去 scheme(://)、去路径(第一个 /),用于白名单精确匹配。
    let host = base
        .split("://")
        .nth(1)
        .unwrap_or(&base)
        .split('/')
        .next()
        .unwrap_or(&base)
        .to_string();
    println!("cargo:rustc-env=CHATHUB_ATTACHMENT_BASE_URL_RESOLVED={base}");
    println!("cargo:rustc-env=CHATHUB_ATTACHMENT_HOST_RESOLVED={host}");

    // 编译期注入 AI 润色配置(OpenAI 兼容端点),与上方 ATTACHMENT 同构:
    //   - CHATHUB_AI_BASE_URL_RESOLVED:厂商 OpenAI 兼容基地址(去尾斜杠);缺失回落通义千问端点。
    //   - CHATHUB_AI_MODEL_RESOLVED:模型名;缺失回落 qwen-flash。
    //   - CHATHUB_AI_API_KEY_RESOLVED:密钥;缺失回落空串占位(不让构建失败,运行时空串 →「AI 未配置」)。
    // 三者运行时由 ai_polish.rs 用 env!("..._RESOLVED") 读取。release 缺 key 时告警提示已禁用。
    println!("cargo:rerun-if-env-changed=CHATHUB_AI_BASE_URL");
    println!("cargo:rerun-if-env-changed=CHATHUB_AI_MODEL");
    println!("cargo:rerun-if-env-changed=CHATHUB_AI_API_KEY");

    let ai_base = std::env::var("CHATHUB_AI_BASE_URL")
        .unwrap_or_else(|_| "https://dashscope.aliyuncs.com/compatible-mode/v1".to_string());
    let ai_base = ai_base.trim_end_matches('/').to_string();
    let ai_model = std::env::var("CHATHUB_AI_MODEL").unwrap_or_else(|_| "qwen-flash".to_string());
    // 缺失时回落空串(对齐上方注释:运行时空串 →「AI 未配置」),绝不内置真实 key ——
    // 硬编码 key 会随每个分发包出厂、且进 git 历史泄漏。key 只由 CI/打包环境 env 注入。
    let ai_key = std::env::var("CHATHUB_AI_API_KEY").unwrap_or_else(|_| {
        if std::env::var("PROFILE").as_deref() == Ok("release") {
            println!("cargo:warning=CHATHUB_AI_API_KEY not set; AI polish disabled in this build");
        }
        String::new()
    });
    println!("cargo:rustc-env=CHATHUB_AI_BASE_URL_RESOLVED={ai_base}");
    println!("cargo:rustc-env=CHATHUB_AI_MODEL_RESOLVED={ai_model}");
    println!("cargo:rustc-env=CHATHUB_AI_API_KEY_RESOLVED={ai_key}");

    tauri_build::build()
}
