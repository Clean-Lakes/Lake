//go:build darwin && cgo

package legacykeychain

/*
#cgo LDFLAGS: -framework Security -framework CoreFoundation
#include <Security/Security.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdlib.h>
#include <string.h>

static CFStringRef lake_cf_string(const char *value) {
    return CFStringCreateWithCString(kCFAllocatorDefault, value, kCFStringEncodingUTF8);
}

static CFMutableDictionaryRef lake_keychain_query(const char *service, const char *account) {
    CFMutableDictionaryRef query = CFDictionaryCreateMutable(kCFAllocatorDefault, 0,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CFStringRef serviceValue = lake_cf_string(service);
    CFStringRef accountValue = lake_cf_string(account);
    if (!query || !serviceValue || !accountValue) {
        if (query) CFRelease(query);
        if (serviceValue) CFRelease(serviceValue);
        if (accountValue) CFRelease(accountValue);
        return NULL;
    }
    CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword);
    CFDictionarySetValue(query, kSecAttrService, serviceValue);
    CFDictionarySetValue(query, kSecAttrAccount, accountValue);
    CFRelease(serviceValue);
    CFRelease(accountValue);
    return query;
}

static OSStatus lake_keychain_add(const char *service, const char *account,
                                  const void *secret, size_t length) {
    CFMutableDictionaryRef query = lake_keychain_query(service, account);
    CFDataRef data = CFDataCreate(kCFAllocatorDefault, secret, (CFIndex)length);
    if (!query || !data) {
        if (query) CFRelease(query);
        if (data) CFRelease(data);
        return errSecAllocate;
    }
    CFDictionarySetValue(query, kSecValueData, data);
    OSStatus status = SecItemAdd(query, NULL);
    CFRelease(data);
    CFRelease(query);
    return status;
}

static OSStatus lake_keychain_read(const char *service, const char *account,
                                   void **secret, size_t *length) {
    CFMutableDictionaryRef query = lake_keychain_query(service, account);
    if (!query) return errSecAllocate;
    CFDictionarySetValue(query, kSecReturnData, kCFBooleanTrue);
    CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);
    CFTypeRef result = NULL;
    OSStatus status = SecItemCopyMatching(query, &result);
    CFRelease(query);
    if (status != errSecSuccess) return status;
    CFDataRef data = (CFDataRef)result;
    *length = (size_t)CFDataGetLength(data);
    *secret = malloc(*length ? *length : 1);
    if (!*secret) {
        CFRelease(result);
        return errSecAllocate;
    }
    if (*length) memcpy(*secret, CFDataGetBytePtr(data), *length);
    CFRelease(result);
    return errSecSuccess;
}

static OSStatus lake_keychain_delete(const char *service, const char *account) {
    CFMutableDictionaryRef query = lake_keychain_query(service, account);
    if (!query) return errSecAllocate;
    OSStatus status = SecItemDelete(query);
    CFRelease(query);
    return status;
}

static void lake_secret_free(void *secret, size_t length) {
    volatile unsigned char *p = (volatile unsigned char *)secret;
    for (size_t i = 0; i < length; i++) p[i] = 0;
    free(secret);
}
*/
import "C"

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"unsafe"
)

const service = "Clean-Lakes.Lake.SSH"
const modelService = "Clean-Lakes.Lake.Model"
const prefix = "keychain:"

// Keychain stores SSH private-key bytes in the current user's macOS keychain.
// The returned reference is safe to keep in SQLite and journal data.
type Keychain struct{}

func (Keychain) Import(privateKey []byte) (string, error) {
	if len(privateKey) == 0 {
		return "", errors.New("私钥内容为空")
	}
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		return "", fmt.Errorf("生成钥匙串引用: %w", err)
	}
	account := "ssh/" + hex.EncodeToString(id)
	cService, cAccount := C.CString(service), C.CString(account)
	defer C.free(unsafe.Pointer(cService))
	defer C.free(unsafe.Pointer(cAccount))
	cSecret := C.CBytes(privateKey)
	defer C.lake_secret_free(cSecret, C.size_t(len(privateKey)))
	status := C.lake_keychain_add(cService, cAccount, cSecret, C.size_t(len(privateKey)))
	if status != C.errSecSuccess {
		return "", fmt.Errorf("导入 macOS 钥匙串失败 (OSStatus %d)", int(status))
	}
	return prefix + account, nil
}

func (Keychain) Load(ref string) ([]byte, error) {
	account, err := accountFromRef(ref)
	if err != nil {
		return nil, err
	}
	cService, cAccount := C.CString(service), C.CString(account)
	defer C.free(unsafe.Pointer(cService))
	defer C.free(unsafe.Pointer(cAccount))
	var cSecret unsafe.Pointer
	var length C.size_t
	status := C.lake_keychain_read(cService, cAccount, &cSecret, &length)
	if status != C.errSecSuccess {
		return nil, fmt.Errorf("读取 macOS 钥匙串失败 (OSStatus %d)", int(status))
	}
	defer C.lake_secret_free(cSecret, length)
	if length == 0 {
		return nil, errors.New("钥匙串中的私钥内容为空")
	}
	return C.GoBytes(cSecret, C.int(length)), nil
}

func (Keychain) Delete(ref string) error {
	account, err := accountFromRef(ref)
	if err != nil {
		return err
	}
	cService, cAccount := C.CString(service), C.CString(account)
	defer C.free(unsafe.Pointer(cService))
	defer C.free(unsafe.Pointer(cAccount))
	status := C.lake_keychain_delete(cService, cAccount)
	if status != C.errSecSuccess {
		return fmt.Errorf("清理钥匙串条目失败 (OSStatus %d)", int(status))
	}
	return nil
}

func accountFromRef(ref string) (string, error) {
	if !strings.HasPrefix(ref, prefix+"ssh/") {
		return "", errors.New("无效的 Lake 钥匙串引用")
	}
	id := strings.TrimPrefix(ref, prefix+"ssh/")
	if len(id) != 32 {
		return "", errors.New("无效的 Lake 钥匙串引用")
	}
	if _, err := hex.DecodeString(id); err != nil {
		return "", errors.New("无效的 Lake 钥匙串引用")
	}
	return "ssh/" + id, nil
}

// PutModelAPIKey stores a model provider's API key without writing it to disk.
func (Keychain) PutModelAPIKey(provider string, key []byte) error {
	if !validProvider(provider) || len(key) == 0 || len(key) > 65536 {
		return errors.New("无效的模型提供方或 API Key")
	}
	cService, cAccount := C.CString(modelService), C.CString("api/"+provider)
	defer C.free(unsafe.Pointer(cService))
	defer C.free(unsafe.Pointer(cAccount))
	cSecret := C.CBytes(key)
	defer C.lake_secret_free(cSecret, C.size_t(len(key)))
	status := C.lake_keychain_add(cService, cAccount, cSecret, C.size_t(len(key)))
	if status == C.errSecDuplicateItem {
		// An update preserves the old item's access list. Replace it so a
		// newly signed build owns the refreshed credential.
		status = C.lake_keychain_delete(cService, cAccount)
		if status == C.errSecSuccess {
			status = C.lake_keychain_add(cService, cAccount, cSecret, C.size_t(len(key)))
		}
	}
	if status != C.errSecSuccess {
		return fmt.Errorf("保存模型 API Key 到 macOS 钥匙串失败 (OSStatus %d)", int(status))
	}
	return nil
}

func (Keychain) LoadModelAPIKey(provider string) ([]byte, error) {
	if !validProvider(provider) {
		return nil, errors.New("无效的模型提供方")
	}
	cService, cAccount := C.CString(modelService), C.CString("api/"+provider)
	defer C.free(unsafe.Pointer(cService))
	defer C.free(unsafe.Pointer(cAccount))
	var cSecret unsafe.Pointer
	var length C.size_t
	status := C.lake_keychain_read(cService, cAccount, &cSecret, &length)
	if status != C.errSecSuccess {
		return nil, fmt.Errorf("读取模型 API Key 失败 (OSStatus %d)", int(status))
	}
	defer C.lake_secret_free(cSecret, length)
	if length == 0 || length > 65536 {
		return nil, errors.New("钥匙串中的模型 API Key 无效")
	}
	return C.GoBytes(cSecret, C.int(length)), nil
}

func (Keychain) DeleteModelAPIKey(provider string) error {
	if !validProvider(provider) {
		return errors.New("无效的模型提供方")
	}
	cService, cAccount := C.CString(modelService), C.CString("api/"+provider)
	defer C.free(unsafe.Pointer(cService))
	defer C.free(unsafe.Pointer(cAccount))
	status := C.lake_keychain_delete(cService, cAccount)
	if status != C.errSecSuccess {
		return fmt.Errorf("清理模型 API Key 失败 (OSStatus %d)", int(status))
	}
	return nil
}

func validProvider(provider string) bool {
	if provider == "" || len(provider) > 64 {
		return false
	}
	for _, ch := range provider {
		if ch < 'a' || ch > 'z' {
			if ch < '0' || ch > '9' {
				if ch != '-' && ch != '_' {
					return false
				}
			}
		}
	}
	return true
}
