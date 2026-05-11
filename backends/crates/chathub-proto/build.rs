// backends/crates/chathub-proto/build.rs
//! tonic-build 把 ../../../proto/chathub/v1/*.proto 编出 Rust 类型,
//! 输出到 OUT_DIR,在 src/lib.rs 里通过 tonic::include_proto! 引入。

use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 用 vendored 的 protoc 二进制,避免依赖系统 protoc
    std::env::set_var("PROTOC", protoc_bin_vendored::protoc_bin_path()?);

    let proto_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../proto");

    let proto_files = [
        proto_root.join("chathub/v1/common.proto"),
        proto_root.join("chathub/v1/auth.proto"),
        proto_root.join("chathub/v1/error.proto"),
        proto_root.join("chathub/v1/message.proto"),
        proto_root.join("chathub/v1/event.proto"),
        proto_root.join("chathub/v1/hub.proto"),
    ];

    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed={}", proto_root.display());
    for f in &proto_files {
        println!("cargo:rerun-if-changed={}", f.display());
    }

    tonic_build::configure()
        .build_client(true)
        .build_server(true) // server 端 Plan 2 stub_relay 测试要用
        .compile_well_known_types(false)
        .type_attribute(".chathub.v1.UserProfile",  "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.WecomAccount", "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.MessageBody",       "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.MessageBody.Kind",  "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.TextBody",          "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.Mention",           "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.ReplyToRef",        "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.RemoteId",          "#[derive(serde::Serialize, serde::Deserialize)]")
        // ↓↓↓ Plan 3 新增 5 条(SystemSignal.Kind 是 nested regular enum,父 message
        //      的 attribute 已 cascade,显式加会触发 conflicting impl Serialize)↓↓↓
        .type_attribute(".chathub.v1.ServerEvent",       "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.ServerEvent.Body",  "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.IncomingMsg",       "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.SystemSignal",      "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.SendResponse",      "#[derive(serde::Serialize, serde::Deserialize)]")
        // ↓↓↓ Plan 4 新增:ServerEvent.Body 的 3 个 oneof variant 类型需要 serde
        //      MessageStatusChange.Status 是 nested enum,父 message attribute 已 cascade,
        //      不单独加(否则 conflicting impl,与 SystemSignal.Kind 同理)↓↓↓
        .type_attribute(".chathub.v1.MessageRecalled",     "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.ReadReceipt",         "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.MessageStatusChange", "#[derive(serde::Serialize, serde::Deserialize)]")
        .compile_protos(&proto_files, &[proto_root])?;

    Ok(())
}
