//! Desktop integration. Only validated library directories reach the system shell.
use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem as Native, Submenu},
    Manager,
};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
pub struct ImmersiveWindow {
    enabled: AtomicBool,
    restore: Mutex<Option<WindowRestore>>,
}

struct WindowRestore {
    #[cfg(not(target_os = "macos"))]
    decorated: bool,
    #[cfg(all(not(windows), not(target_os = "macos")))]
    maximized: bool,
    #[cfg(not(target_os = "macos"))]
    resizable: bool,
    #[cfg(all(not(windows), not(target_os = "macos")))]
    position: tauri::PhysicalPosition<i32>,
    #[cfg(all(not(windows), not(target_os = "macos")))]
    size: tauri::PhysicalSize<u32>,
    #[cfg(windows)]
    placement: windows_sys::Win32::UI::WindowsAndMessaging::WINDOWPLACEMENT,
    #[cfg(windows)]
    styles: (isize, isize),
    #[cfg(windows)]
    shadow: bool,
    #[cfg(not(target_os = "macos"))]
    menu_visible: bool,
    #[cfg(target_os = "macos")]
    presentation: usize,
}

/// Geometry and shell presentation change on the UI thread as one operation.
/// Called from the blocking IPC dispatcher, never from a native UI callback.
pub fn set_immersive(app: &tauri::AppHandle, enabled: bool, bars_visible: bool) -> Result<()> {
    let app_handle = app.clone();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = sender.send(set_immersive_inner(&app_handle, enabled, bars_visible));
    })?;
    receiver.recv().context("沉浸窗口操作中断")?
}

fn set_immersive_inner(app: &tauri::AppHandle, enabled: bool, bars_visible: bool) -> Result<()> {
    let window = app.get_webview_window("main").context("主窗口不存在")?;
    let mode = app.state::<ImmersiveWindow>();
    let mut restore = mode
        .restore
        .lock()
        .map_err(|_| anyhow::anyhow!("窗口状态锁不可用"))?;
    if enabled {
        if restore.is_none() {
            // Leave a separate F11 native fullscreen before capturing normal placement.
            window.set_fullscreen(false)?;
            *restore = Some(WindowRestore {
                #[cfg(not(target_os = "macos"))]
                decorated: window.is_decorated()?,
                #[cfg(all(not(windows), not(target_os = "macos")))]
                maximized: window.is_maximized()?,
                #[cfg(not(target_os = "macos"))]
                resizable: window.is_resizable()?,
                #[cfg(all(not(windows), not(target_os = "macos")))]
                position: window.outer_position()?,
                #[cfg(all(not(windows), not(target_os = "macos")))]
                size: window.inner_size()?,
                #[cfg(windows)]
                placement: windows_placement(&window)?,
                #[cfg(windows)]
                styles: windows_styles(&window)?,
                #[cfg(windows)]
                shadow: app
                    .config()
                    .app
                    .windows
                    .iter()
                    .find(|config| config.label == "main")
                    .map(|config| config.shadow)
                    .unwrap_or(true),
                #[cfg(not(target_os = "macos"))]
                menu_visible: window.is_menu_visible()?,
                #[cfg(target_os = "macos")]
                presentation: mac_presentation()?.presentationOptions().bits(),
            });
            #[cfg(target_os = "macos")]
            window.set_simple_fullscreen(true)?;
            #[cfg(not(target_os = "macos"))]
            {
                let monitor = window.current_monitor()?.context("无法获取当前显示器")?;
                window.hide_menu()?;
                window.unmaximize()?;
                window.set_decorations(false)?;
                window.set_resizable(false)?;
                #[cfg(windows)]
                window.set_shadow(false)?;
                #[cfg(windows)]
                windows_system_bars(&window, bars_visible)?;
                #[cfg(windows)]
                windows_borderless(&window, &monitor)?;
                #[cfg(not(windows))]
                {
                    window.set_position(*monitor.position())?;
                    window.set_size(*monitor.size())?;
                }
            }
        }
        #[cfg(windows)]
        windows_system_bars(&window, bars_visible)?;
        #[cfg(target_os = "macos")]
        {
            use objc2_app_kit::NSApplicationPresentationOptions as Options;
            let options = if bars_visible {
                Options::from_bits_retain(restore.as_ref().unwrap().presentation)
            } else {
                Options::AutoHideDock | Options::AutoHideMenuBar
            };
            mac_presentation()?.setPresentationOptions(options);
        }
        mode.enabled.store(true, Ordering::Relaxed);
    } else {
        if let Some(previous) = restore.as_ref() {
            #[cfg(windows)]
            windows_system_bars(&window, true)?;
            #[cfg(target_os = "macos")]
            window.set_simple_fullscreen(false)?;
            #[cfg(not(target_os = "macos"))]
            {
                window.set_decorations(previous.decorated)?;
                window.set_resizable(previous.resizable)?;
                #[cfg(windows)]
                window.set_shadow(previous.shadow)?;
                if previous.menu_visible {
                    window.show_menu()?;
                } else {
                    window.hide_menu()?;
                }
                #[cfg(windows)]
                unsafe {
                    use windows_sys::Win32::UI::WindowsAndMessaging::{
                        SetWindowLongPtrW, GWL_EXSTYLE, GWL_STYLE,
                    };
                    SetWindowLongPtrW(window.hwnd()?.0, GWL_STYLE, previous.styles.0);
                    SetWindowLongPtrW(window.hwnd()?.0, GWL_EXSTYLE, previous.styles.1);
                    if windows_sys::Win32::UI::WindowsAndMessaging::SetWindowPlacement(
                        window.hwnd()?.0,
                        &previous.placement,
                    ) == 0
                    {
                        bail!("无法恢复窗口位置");
                    }
                    // Do not leave the immersion exemption on later native F11 windows.
                    let property: Vec<u16> = "NonRudeHWND\0".encode_utf16().collect();
                    windows_sys::Win32::UI::WindowsAndMessaging::RemovePropW(
                        window.hwnd()?.0,
                        property.as_ptr(),
                    );
                }
                #[cfg(not(windows))]
                {
                    window.set_position(previous.position)?;
                    window.set_size(previous.size)?;
                    if previous.maximized {
                        window.maximize()?;
                    } else {
                        window.unmaximize()?;
                    }
                }
            }
        }
        *restore = None;
        mode.enabled.store(false, Ordering::Relaxed);
    }
    Ok(())
}

#[cfg(windows)]
fn windows_styles(window: &tauri::WebviewWindow) -> Result<(isize, isize)> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, GWL_EXSTYLE, GWL_STYLE};
    let hwnd = window.hwnd()?.0;
    Ok(unsafe {
        (
            GetWindowLongPtrW(hwnd, GWL_STYLE),
            GetWindowLongPtrW(hwnd, GWL_EXSTYLE),
        )
    })
}

#[cfg(windows)]
fn windows_borderless(window: &tauri::WebviewWindow, monitor: &tauri::Monitor) -> Result<()> {
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    let hwnd = window.hwnd()?.0;
    let (style, extended) = windows_styles(window)?;
    unsafe {
        SetWindowLongPtrW(
            hwnd,
            GWL_STYLE,
            style & !((WS_CAPTION | WS_THICKFRAME | WS_BORDER | WS_DLGFRAME) as isize),
        );
        SetWindowLongPtrW(
            hwnd,
            GWL_EXSTYLE,
            extended
                & !((WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE | WS_EX_DLGMODALFRAME | WS_EX_STATICEDGE)
                    as isize),
        );
        let position = monitor.position();
        let size = monitor.size();
        if SetWindowPos(
            hwnd,
            HWND_NOTOPMOST,
            position.x,
            position.y,
            size.width as i32,
            size.height as i32,
            SWP_NOACTIVATE | SWP_FRAMECHANGED,
        ) == 0
        {
            bail!("无法设置无边框窗口范围");
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn mac_presentation() -> Result<objc2::rc::Retained<objc2_app_kit::NSApplication>> {
    let main = objc2::MainThreadMarker::new().context("菜单栏操作必须在主线程")?;
    Ok(objc2_app_kit::NSApplication::sharedApplication(main))
}

#[cfg(windows)]
fn windows_placement(
    window: &tauri::WebviewWindow,
) -> Result<windows_sys::Win32::UI::WindowsAndMessaging::WINDOWPLACEMENT> {
    let mut placement = windows_sys::Win32::UI::WindowsAndMessaging::WINDOWPLACEMENT::default();
    placement.length = std::mem::size_of_val(&placement) as u32;
    if unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::GetWindowPlacement(
            window.hwnd()?.0,
            &mut placement,
        )
    } == 0
    {
        bail!("无法保存窗口位置");
    }
    Ok(placement)
}

/// Only marks our own HWND. Explorer owns taskbar visibility and restores it
/// when another application becomes active; no global taskbar hide/show calls.
#[cfg(windows)]
fn windows_system_bars(window: &tauri::WebviewWindow, visible: bool) -> Result<()> {
    use windows::Win32::{
        Foundation::HWND,
        System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER},
        UI::Shell::{ITaskbarList2, TaskbarList},
    };
    use windows_sys::Win32::{
        System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
        UI::WindowsAndMessaging::{
            RemovePropW, SetPropW, SetWindowPos, HWND_NOTOPMOST, SWP_FRAMECHANGED, SWP_NOACTIVATE,
            SWP_NOMOVE, SWP_NOSIZE,
        },
    };
    let hwnd = window.hwnd()?.0;
    let property: Vec<u16> = "NonRudeHWND\0".encode_utf16().collect();
    unsafe {
        let initialized = CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32);
        // WebView2 already initializes this UI thread; changed apartment is usable.
        if initialized < 0 && initialized != -2147417850 {
            bail!("无法初始化系统栏：{initialized:#x}");
        }
        let result = (|| -> Result<()> {
            if visible {
                if SetPropW(hwnd, property.as_ptr(), 1usize as _) == 0 {
                    bail!("无法标记系统栏显示状态");
                }
            } else {
                RemovePropW(hwnd, property.as_ptr());
            }
            let taskbar: ITaskbarList2 =
                CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER)?;
            taskbar.HrInit()?;
            taskbar.MarkFullscreenWindow(HWND(hwnd), !visible)?;
            // Re-evaluate shell coverage without changing the client rectangle or focus.
            if SetWindowPos(
                hwnd,
                HWND_NOTOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            ) == 0
            {
                bail!("无法更新系统栏覆盖关系");
            }
            Ok(())
        })();
        if initialized >= 0 {
            CoUninitialize();
        }
        result
    }
}

#[cfg(all(windows, debug_assertions))]
pub fn shell_test_state(window: &tauri::WebviewWindow) -> Result<String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        FindWindowW, GetForegroundWindow, GetPropW, GetTopWindow, GetWindow, IsWindowVisible,
        GW_HWNDNEXT,
    };
    let own = window.hwnd()?.0;
    let name: Vec<u16> = "Shell_TrayWnd\0".encode_utf16().collect();
    let property: Vec<u16> = "NonRudeHWND\0".encode_utf16().collect();
    unsafe {
        let taskbar = FindWindowW(name.as_ptr(), std::ptr::null());
        let mut next = GetTopWindow(std::ptr::null_mut());
        let mut taskbar_above = false;
        while !next.is_null() && next != own {
            if next == taskbar {
                taskbar_above = true;
            }
            next = GetWindow(next, GW_HWNDNEXT);
        }
        Ok(
            serde_json::json!({"foreground":GetForegroundWindow() == own,
            "taskbarVisible":IsWindowVisible(taskbar) != 0, "taskbarAbove":taskbar_above,
            "nonRude":!GetPropW(own, property.as_ptr()).is_null()})
            .to_string(),
        )
    }
}

pub fn argument_paths(args: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<String> {
    let mut paths = Vec::new();
    let mut literal = false;
    for arg in args.into_iter().skip(1) {
        if !literal && arg == "--" {
            literal = true;
            continue;
        }
        if arg.is_empty() || (!literal && arg.starts_with('-')) {
            continue;
        }
        let path = Path::new(&arg);
        let absolute = if path.is_absolute() {
            path.to_owned()
        } else {
            cwd.join(path)
        };
        // Existence is checked here, format support remains the importer's responsibility.
        if let Ok(path) = absolute.canonicalize() {
            let value = shell_path(&path).to_string_lossy().into_owned();
            if !paths.contains(&value) {
                paths.push(value);
            }
        }
    }
    paths
}

fn shell_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let value = path.to_string_lossy();
        if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        if let Some(disk) = value.strip_prefix(r"\\?\") {
            return PathBuf::from(disk);
        }
    }
    path.to_owned()
}

pub fn reveal_target(backend: &crate::storage::Backend, id: &str) -> Result<PathBuf> {
    backend.book(id)?;
    let root = backend.root.join("library").canonicalize()?;
    let target = backend.dir(id)?.canonicalize()?;
    if !target.starts_with(&root) || target == root || !target.is_dir() {
        bail!("拒绝定位越界的书目录");
    }
    Ok(shell_path(&target))
}

#[cfg(windows)]
pub fn reveal(path: &Path) -> Result<()> {
    use std::{os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::{
        System::Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED},
        UI::Shell::{SHOpenFolderAndSelectItems, SHParseDisplayName},
    };
    let path = shell_path(path);
    let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // spawn_blocking runs outside the UI thread. Balance COM even when a shell API fails.
    unsafe {
        let initialized = CoInitializeEx(ptr::null(), COINIT_APARTMENTTHREADED as u32);
        if initialized < 0 {
            bail!("无法初始化文件管理器：{initialized:#x}");
        }
        let result = (|| {
            let mut pidl = ptr::null_mut();
            let parsed = SHParseDisplayName(
                name.as_ptr(),
                ptr::null_mut(),
                &mut pidl,
                0,
                ptr::null_mut(),
            );
            if parsed < 0 {
                bail!("无法定位目录：{parsed:#x}");
            }
            let opened = SHOpenFolderAndSelectItems(pidl, 0, ptr::null(), 0);
            CoTaskMemFree(pidl.cast());
            if opened < 0 {
                bail!("无法打开文件管理器：{opened:#x}");
            }
            Ok(())
        })();
        CoUninitialize();
        result
    }
}

/// Open the directory itself rather than selecting it in its parent.
pub fn open_directory(path: &Path) -> Result<()> {
    if !path.is_dir() {
        bail!("目录不存在，请重新生成任务文件");
    }
    let path = shell_path(path);
    #[cfg(windows)]
    {
        use std::{os::windows::ffi::OsStrExt, ptr};
        use windows_sys::Win32::System::Com::{
            CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED,
        };
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let operation: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
        let initialized = unsafe { CoInitializeEx(ptr::null(), COINIT_APARTMENTTHREADED as u32) };
        if initialized < 0 {
            bail!("无法初始化文件管理器：{initialized:#x}");
        }
        let result = unsafe {
            let result = ShellExecuteW(
                ptr::null_mut(),
                operation.as_ptr(),
                name.as_ptr(),
                ptr::null(),
                ptr::null(),
                1,
            ) as isize;
            CoUninitialize();
            result
        };
        if result <= 32 {
            bail!("无法打开任务文件夹：系统错误 {result}");
        }
    }
    #[cfg(not(windows))]
    {
        #[cfg(target_os = "macos")]
        let status = std::process::Command::new("/usr/bin/open")
            .arg(&path)
            .status()?;
        #[cfg(not(target_os = "macos"))]
        let status = std::process::Command::new("xdg-open").arg(&path).status()?;
        if !status.success() {
            bail!("无法打开任务文件夹");
        }
    }
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn shell_accepts_normal_disk_and_unc_paths_after_canonicalization() {
        assert_eq!(
            shell_path(Path::new(r"\\?\C:\任务\批次一")),
            PathBuf::from(r"C:\任务\批次一")
        );
        assert_eq!(
            shell_path(Path::new(r"\\?\UNC\server\share\任务")),
            PathBuf::from(r"\\server\share\任务")
        );
        assert_eq!(
            shell_path(Path::new(r"C:\普通目录")),
            PathBuf::from(r"C:\普通目录")
        );
    }
}

#[cfg(not(windows))]
pub fn reveal(path: &Path) -> Result<()> {
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("/usr/bin/open")
        .arg("-R")
        .arg(path)
        .status()?;
    #[cfg(not(target_os = "macos"))]
    let status = std::process::Command::new("xdg-open").arg(path).status()?;
    if !status.success() {
        bail!("无法打开文件管理器");
    }
    Ok(())
}

pub fn install(app: &tauri::AppHandle) -> Result<()> {
    let item =
        |id, label, accelerator: Option<&str>| MenuItem::with_id(app, id, label, true, accelerator);
    let separator = || Native::separator(app);
    let file = Submenu::with_id_and_items(
        app,
        "file",
        "文件",
        true,
        &[
            &item("import", "导入漫画 / 小说…", Some("CmdOrCtrl+O"))?,
            &item("settings", "打开设置…", Some("CmdOrCtrl+D"))?,
            &separator()?,
            &item("quit", "退出", Some("CmdOrCtrl+Q"))?,
        ],
    )?;
    let edit = Submenu::with_id_and_items(
        app,
        "edit",
        "编辑",
        true,
        &[
            // Windows native Undo/Redo are unsupported. Keep keyboard handling in the reader
            // and editable controls so drawing undo does not become WebView text undo.
            &item("undo", "撤销", None)?,
            &item("redo", "重做", None)?,
            &separator()?,
            &Native::cut(app, Some("剪切"))?,
            &Native::copy(app, Some("复制"))?,
            &Native::paste(app, Some("粘贴"))?,
            &Native::select_all(app, Some("全选"))?,
            &separator()?,
            &item("searchLibrary", "在全库中搜索", None)?,
        ],
    )?;
    let view = Submenu::with_id_and_items(
        app,
        "view",
        "视图",
        true,
        &[
            &item("toggleSidebar", "显示 / 隐藏侧栏", Some("CmdOrCtrl+B"))?,
            &separator()?,
            &item("zoomIn", "放大", Some("CmdOrCtrl+Plus"))?,
            &item("zoomOut", "缩小", Some("CmdOrCtrl+-"))?,
            &item("zoomReset", "实际大小", Some("CmdOrCtrl+0"))?,
            &separator()?,
            &item("fullscreen", "进入 / 退出全屏", Some("F11"))?,
        ],
    )?;
    #[cfg(debug_assertions)]
    view.append(&item("devtools", "开发者工具", Some("CmdOrCtrl+Shift+I"))?)?;
    // Arrow keys remain in the readers: RTL changes their meaning, and text inputs
    // and library selection must still receive their normal cursor movement.
    let reading = Submenu::with_id_and_items(
        app,
        "reading",
        "阅读",
        true,
        &[
            &item("prevPage", "上一页 / 章", None)?,
            &item("nextPage", "下一页 / 章", None)?,
            &separator()?,
            &item("toggleDictionary", "查词面板", Some("CmdOrCtrl+Shift+D"))?,
        ],
    )?;
    let help = Submenu::with_id_and_items(
        app,
        "help",
        "帮助",
        true,
        &[&item("about", "关于 あられブック", None)?],
    )?;
    let menu = Menu::new(app)?;
    #[cfg(target_os = "macos")]
    menu.append(&Submenu::with_items(
        app,
        "あられブック",
        true,
        &[
            &item("about", "关于 あられブック", None)?,
            &separator()?,
            &Native::services(app, None)?,
            &separator()?,
            &Native::hide(app, None)?,
            &Native::hide_others(app, None)?,
            &Native::show_all(app, None)?,
        ],
    )?)?;
    menu.append_items(&[&file, &edit, &view, &reading, &help])?;
    app.set_menu(menu)?;
    Ok(())
}

pub fn menu_action(app: &tauri::AppHandle, id: &str) -> Result<()> {
    match id {
        "import" | "settings" | "searchLibrary" | "toggleSidebar" | "zoomIn" | "zoomOut"
        | "zoomReset" | "prevPage" | "nextPage" | "toggleDictionary" => {
            crate::event(app, "shell:command", serde_json::json!({"command":id}))
        }
        "fullscreen" => {
            if app
                .state::<ImmersiveWindow>()
                .enabled
                .load(Ordering::Relaxed)
            {
                crate::event(
                    app,
                    "shell:command",
                    serde_json::json!({"command":"exitImmersive"}),
                );
                return Ok(());
            }
            let window = app.get_webview_window("main").context("没有主窗口")?;
            window.set_fullscreen(!window.is_fullscreen()?)?;
        }
        "undo" | "redo" => {
            let window = app.get_webview_window("main").context("没有主窗口")?;
            // Fixed scripts only; no user text is interpolated into JavaScript.
            window.eval(if id == "undo" {
                "if(document.activeElement?.matches('input,textarea,[contenteditable=true]')){document.execCommand('undo')}else{window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true}))}"
            } else {
                "if(document.activeElement?.matches('input,textarea,[contenteditable=true]')){document.execCommand('redo')}else{window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,shiftKey:true,bubbles:true}))}"
            })?;
        }
        "about" => {
            app.dialog().message("あられブック (ARaLeBook)\n漫画与小说的本地书库 · 分词 · 点词查义\nTauri 迁移预览 0.1.0\n书库与离线功能在本机运行；翻译和 AI 按所选配置发送请求。")
            .title("关于 あられブック").show(|_| {});
        }
        "quit" => app.exit(0),
        #[cfg(debug_assertions)]
        "devtools" => {
            let window = app.get_webview_window("main").context("没有主窗口")?;
            if window.is_devtools_open() {
                window.close_devtools();
            } else {
                window.open_devtools();
            }
        }
        _ => bail!("未知菜单操作"),
    }
    Ok(())
}
