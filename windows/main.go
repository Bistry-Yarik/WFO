package main

import (
	_ "embed"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"
)

//go:embed index.html
var game []byte

func main() {
	if err := launch(); err != nil {
		message := utf16("Не удалось открыть WFO.\n" + err.Error())
		title := utf16("WFO")
		syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW").Call(
			0, uintptr(unsafe.Pointer(message)), uintptr(unsafe.Pointer(title)), 0x10)
	}
}

func launch() error {
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
	address := (&url.URL{Scheme: "file", Path: "/" + filepath.ToSlash(page)}).String()
	for _, variable := range []string{"ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"} {
		root := os.Getenv(variable)
		if root == "" {
			continue
		}
		edge := filepath.Join(root, "Microsoft", "Edge", "Application", "msedge.exe")
		if err := exec.Command(edge, "--app="+address).Start(); err == nil {
			return nil
		}
	}
	verb := utf16("open")
	file := utf16(page)
	result, _, _ := syscall.NewLazyDLL("shell32.dll").NewProc("ShellExecuteW").Call(
		0, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(file)), 0, 0, 1)
	if result <= 32 {
		return fmt.Errorf("Windows ShellExecute: %d (%s)", result, page)
	}
	return nil
}

func utf16(text string) *uint16 {
	value, _ := syscall.UTF16PtrFromString(text)
	return value
}
