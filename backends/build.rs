fn main() {
    // 编译期把 CHATHUB_ATTACHMENT_BASE_URL env 注入为两个常量:
    //   - CHATHUB_ATTACHMENT_BASE_URL_RESOLVED:完整基地址(去尾斜杠),拼附件预览 URL 用;
    //   - CHATHUB_ATTACHMENT_HOST_RESOLVED:取其 host,供 image_cache.rs 的 SSRF 白名单用。
    // 没设 env 时回落到 filet.jdd51.com(与历史硬编码一致);release 缺失时告警,
    // 避免发出去的包拼错附件域。机制与 chathub-net/build.rs 注入 RELAY_URL 同构。
    println!("cargo:rerun-if-env-changed=CHATHUB_ATTACHMENT_BASE_URL");
    println!("cargo:rerun-if-env-changed=PROFILE");

    let base = std::env::var("CHATHUB_ATTACHMENT_BASE_URL").unwrap_or_else(|_| {
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

    tauri_build::build()
}
