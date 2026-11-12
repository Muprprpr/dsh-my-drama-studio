package studio

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// Use one empty file per workspace. Windows allows locking past EOF and releases
// its byte ranges when the handle closes, including after a process exits.
func (p *project) tryTaskLock(id string) (release func(), err error) {
	name := filepath.Join(p.dir, ".drama-studio", "tasks.lock")
	info, err := os.Lstat(name)
	if err == nil && !info.Mode().IsRegular() {
		return nil, errors.New("Studio task lock must be a regular file")
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	file, err := os.OpenFile(name, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	hash := sha256.Sum256([]byte(id))
	offset := windows.Overlapped{
		Offset:     binary.LittleEndian.Uint32(hash[:4]),
		OffsetHigh: binary.LittleEndian.Uint32(hash[4:8]) & 0x7fff_ffff,
	}
	handle := windows.Handle(file.Fd())
	err = windows.LockFileEx(handle, windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &offset)
	if err != nil {
		_ = file.Close()
		if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
			return nil, nil
		}
		return nil, err
	}
	return func() {
		_ = windows.UnlockFileEx(handle, 0, 1, 0, &offset)
		_ = file.Close()
	}, nil
}
