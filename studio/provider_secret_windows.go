package studio

import (
	"errors"
	"unsafe"

	"golang.org/x/sys/windows"
)

func providerSecret(raw []byte, protect bool) ([]byte, error) {
	if len(raw) == 0 || len(raw) > 4<<20 {
		return nil, errors.New("Invalid provider settings length")
	}
	in := windows.DataBlob{Size: uint32(len(raw)), Data: &raw[0]}
	var out windows.DataBlob
	var err error
	if protect {
		err = windows.CryptProtectData(&in, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out)
	} else {
		err = windows.CryptUnprotectData(&in, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out)
	}
	if err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(uintptr(unsafe.Pointer(out.Data))))
	return append([]byte(nil), unsafe.Slice(out.Data, int(out.Size))...), nil
}
