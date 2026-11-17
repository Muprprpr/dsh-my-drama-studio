package studio

import (
	"os"
	"runtime"
	"strings"

	"golang.org/x/sys/windows"
)

var reopenFile = windows.NewLazySystemDLL("kernel32.dll").NewProc("ReOpenFile")

// Keep the exact file opened below the workspace root. Deny write sharing
// while hashing and reading it. Rename is safe because the handle stays open.
func reopenMediaReadOnly(file *os.File) (*os.File, error) {
	handle, _, err := reopenFile.Call(file.Fd(), windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_DELETE, 0)
	runtime.KeepAlive(file)
	if handle == uintptr(windows.InvalidHandle) {
		return nil, err
	}
	return os.NewFile(handle, file.Name()), nil
}

func canonicalWorkspace(directory string) (string, error) {
	name, err := windows.UTF16PtrFromString(directory)
	if err != nil {
		return "", err
	}
	handle, err := windows.CreateFile(name, windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(handle)

	buffer := make([]uint16, 512)
	for {
		length, err := windows.GetFinalPathNameByHandle(handle, &buffer[0], uint32(len(buffer)), 0)
		if err != nil {
			return "", err
		}
		if length >= uint32(len(buffer)) {
			buffer = make([]uint16, length+1)
			continue
		}
		resolved := windows.UTF16ToString(buffer[:length])
		if strings.HasPrefix(resolved, `\\?\UNC\`) {
			return `\\` + strings.TrimPrefix(resolved, `\\?\UNC\`), nil
		}
		return strings.TrimPrefix(resolved, `\\?\`), nil
	}
}
