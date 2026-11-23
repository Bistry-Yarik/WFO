package main

import (
	_ "embed"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"unsafe"

	webview2 "github.com/jchv/go-webview2"
	"github.com/jchv/go-webview2/webviewloader"
	"golang.org/x/sys/windows"
)

//go:embed index.html
var game []byte

func main() {
	runtime.LockOSThread()
	if err := launch(); err != nil {
		showError("Не удалось открыть WFO.\n" + err.Error())
	}
}

func launch() error {
	version, err := webviewloader.GetInstalledVersion()
	if err != nil || version == "" {
		return errors.New("Установите Microsoft WebView2 Runtime: https://aka.ms/webview2")
	}
	base, err := os.UserCacheDir()
	if err != nil {
		return err
	}
	dir := filepath.Join(base, "WFO")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	page := filepath.Join(dir, "index.html")
	if err := os.WriteFile(page, game, 0600); err != nil {
		return err
	}

	_ = windows.SetPriorityClass(windows.CurrentProcess(), windows.ABOVE_NORMAL_PRIORITY_CLASS)
	view := webview2.NewWithOptions(webview2.WebViewOptions{
		DataPath:  filepath.Join(dir, "WebView2"),
		AutoFocus: true,
		WindowOptions: webview2.WindowOptions{
			Title: "WFO", Width: 1100, Height: 750, IconId: 1, Center: true,
		},
	})
	if view == nil {
		return errors.New("Не удалось создать окно WebView2.")
	}
	defer view.Destroy()

	fullscreen := windowFullscreen{handle: uintptr(view.Window())}
	if err := view.Bind("wfoNativeFullscreen", fullscreen.set); err != nil {
		return err
	}

	var room *localRoom
	stopRoom := func() {
		if room != nil {
			room.close()
			room = nil
		}
	}
	defer stopRoom()
	if err := view.Bind("wfoStartLocalRoom", func(code string) (roomAddress, error) {
		stopRoom()
		next, address, err := newLocalRoom(code, game)
		if err == nil {
			room = next
		}
		return address, err
	}); err != nil {
		return err
	}
	if err := view.Bind("wfoStopLocalRoom", stopRoom); err != nil {
		return err
	}

	if err := view.Bind("wfoPollLocalRoom", func() []roomMessage {
		if room == nil {
			return nil
		}
		return room.poll()
	}); err != nil {
		return err
	}
	if err := view.Bind("wfoSendLocalRoom", func(id string, packet json.RawMessage) bool {
		return room == nil || room.send(id, packet)
	}); err != nil {
		return err
	}

	address := (&url.URL{Scheme: "file", Path: "/" + filepath.ToSlash(page)}).String()
	view.Navigate(address)
	view.Run()
	return nil
}

func showError(message string) {
	text, _ := syscall.UTF16PtrFromString(message)
	title, _ := syscall.UTF16PtrFromString("WFO")
	syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW").Call(
		0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), 0x10)
}

type windowPoint struct{ x, y int32 }
type windowRect struct{ left, top, right, bottom int32 }

type windowPlacement struct {
	length, flags, showCommand uint32
	minimized, maximized       windowPoint
	normal                     windowRect
}

type windowFullscreen struct {
	handle    uintptr
	style     uintptr
	placement windowPlacement
	active    bool
}

func (window *windowFullscreen) set(enabled bool) error {
	if window.active == enabled {
		return nil
	}
	const (
		styleIndex       = ^uintptr(15) // GWL_STYLE (-16)
		overlappedWindow = 0x00CF0000
		frameChanged     = 0x0020
		noSize           = 0x0001
		noMove           = 0x0002
		noZOrder         = 0x0004
	)
	user32 := windows.NewLazySystemDLL("user32.dll")
	setStyle := user32.NewProc("SetWindowLongW")
	setPosition := user32.NewProc("SetWindowPos")
	setPlacement := user32.NewProc("SetWindowPlacement")
	if enabled {
		var monitorInfo struct {
			size          uint32
			monitor, work windowRect
			flags         uint32
		}
		monitorInfo.size = uint32(unsafe.Sizeof(monitorInfo))
		monitor, _, _ := user32.NewProc("MonitorFromWindow").Call(window.handle, 2)
		if ok, _, err := user32.NewProc("GetMonitorInfoW").Call(monitor, uintptr(unsafe.Pointer(&monitorInfo))); ok == 0 {
			return err
		}
		window.placement.length = uint32(unsafe.Sizeof(window.placement))
		if ok, _, err := user32.NewProc("GetWindowPlacement").Call(window.handle, uintptr(unsafe.Pointer(&window.placement))); ok == 0 {
			return err
		}
		window.style, _, _ = user32.NewProc("GetWindowLongW").Call(window.handle, styleIndex)
		setStyle.Call(window.handle, styleIndex, window.style&^overlappedWindow)
		bounds := monitorInfo.monitor
		if ok, _, err := setPosition.Call(window.handle, 0, uintptr(bounds.left), uintptr(bounds.top),
			uintptr(bounds.right-bounds.left), uintptr(bounds.bottom-bounds.top), frameChanged); ok == 0 {
			setStyle.Call(window.handle, styleIndex, window.style)
			setPlacement.Call(window.handle, uintptr(unsafe.Pointer(&window.placement)))
			return err
		}
	} else {
		setStyle.Call(window.handle, styleIndex, window.style)
		if ok, _, err := setPlacement.Call(window.handle, uintptr(unsafe.Pointer(&window.placement))); ok == 0 {
			return err
		}
		if ok, _, err := setPosition.Call(window.handle, 0, 0, 0, 0, 0, frameChanged|noSize|noMove|noZOrder); ok == 0 {
			return err
		}
	}
	window.active = enabled
	return nil
}
