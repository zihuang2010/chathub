//! 在编译期把 CHATHUB_RELAY_URL env 注入为 const RELAY_URL;
//! 没设 env 时回落到占位串。warning 只在 release profile 触发,
//! 避免 dev / test 期产生噪声。

fn main() {
    println!("cargo:rerun-if-env-changed=CHATHUB_RELAY_URL");
    println!("cargo:rerun-if-env-changed=PROFILE");

    let url = std::env::var("CHATHUB_RELAY_URL").unwrap_or_else(|_| {
        if std::env::var("PROFILE").as_deref() == Ok("release") {
            println!("cargo:warning=CHATHUB_RELAY_URL not set; falling back to https://relay.example.com (placeholder)");
        }
        "https://relay.example.com".to_string()
    });

    println!("cargo:rustc-env=CHATHUB_RELAY_URL_RESOLVED={url}");
}
