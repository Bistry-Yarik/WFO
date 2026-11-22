package main

import (
	_ "embed"
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
