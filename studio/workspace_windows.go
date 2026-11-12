package studio

import (
	"strings"

	"golang.org/x/sys/windows"
)

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
