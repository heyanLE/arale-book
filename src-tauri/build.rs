fn main() {
    for key in [
        "ARALE_BUILD_CHANNEL",
        "ARALE_BUILD_COMMIT",
        "ARALE_BUILD_TIME",
    ] {
        println!("cargo:rerun-if-env-changed={key}");
        let value = std::env::var(key).unwrap_or_else(|_| {
            if key == "ARALE_BUILD_CHANNEL" {
                "dev".into()
            } else {
                String::new()
            }
        });
        assert!(!value.contains(['\r', '\n']), "Invalid build metadata");
        if key == "ARALE_BUILD_CHANNEL" {
            assert!(
                ["dev", "nightly", "release"].contains(&value.as_str()),
                "Invalid build channel"
            );
        }
        println!("cargo:rustc-env={key}={value}");
    }
    let anki = std::fs::read_to_string("../src/core/study/apkg.ts")
        .unwrap()
        .replace("\r\n", "\n");
    let schema = anki
        .split_once("const SCHEMA = `")
        .unwrap()
        .1
        .split_once("`;")
        .unwrap()
        .0;
    std::fs::write(
        std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("anki-schema.sql"),
        schema,
    )
    .unwrap();
    println!("cargo:rerun-if-changed=../src/core/study/apkg.ts");
    // Keep the native CSP hash tied to the same reader script used by the worker.
    let source = std::fs::read_to_string("../src/shared/reader-bridge.ts")
        .unwrap()
        .replace("\r\n", "\n");
    let tag = source
        .split_once("export const FUSHI_BRIDGE_TAG = '")
        .unwrap()
        .1
        .split_once("';")
        .unwrap()
        .0;
    let script = source
        .split_once("export const READER_BRIDGE_JS = String.raw`")
        .unwrap()
        .1
        .rsplit_once("`;")
        .unwrap()
        .0
        .replace("${FUSHI_BRIDGE_TAG}", tag);
    assert!(
        !script.contains("${"),
        "Unresolved reader bridge interpolation"
    );
    std::fs::write(
        std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("reader-bridge.js"),
        script,
    )
    .unwrap();
    println!("cargo:rerun-if-changed=../src/shared/reader-bridge.ts");
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "arale_invoke",
            "arale_notify",
            "arale_smoke_fixture",
            "arale_smoke_finish",
        ]),
    ))
    .unwrap();
}
