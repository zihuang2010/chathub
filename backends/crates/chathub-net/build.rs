//! 在编译期把 CHATHUB_RELAY_URL env 注入为 const RELAY_URL;
//! 没设 env 时回落到占位串(并 emit cargo warning)。

fn main() {
    println!("cargo:rerun-if-env-changed=CHATHUB_RELAY_URL");

    let url = std::env::var("CHATHUB_RELAY_URL")
        .unwrap_or_else(|_| {
            println!("cargo:warning=CHATHUB_RELAY_URL not set; falling back to https://relay.example.com (placeholder)");
            "https://relay.example.com".to_string()
        });

    // 经由 cfg-attribute 传给 src/lib.rs 的 const 声明:
    println!("cargo:rustc-env=CHATHUB_RELAY_URL_RESOLVED={url}");
}
