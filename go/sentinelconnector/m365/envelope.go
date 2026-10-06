package m365

import (
	"crypto/aes"
	"crypto/cipher"
	"fmt"
)

// The Go mirror of packages/db/src/crypto/envelope.ts's byte layout — this
// package does not own that format, it must read what TS already wrote to
// connectors.credentials (P1-02) and, after a token refresh, write back a
// blob TS's own decryptCredentials can still read. Kept byte-for-byte
// identical rather than reinvented, same reasoning sentineldb.tenant.go
// gives for mirroring tenant-context.ts instead of designing its own
// equivalent mechanism.
const (
	envelopeVersion  = 1
	envelopeIVBytes  = 12
	envelopeTagBytes = 16
	dekBytes         = 32
)

// decryptWithDEK is the exact inverse of envelope.ts's encryptWithDEK:
// [1-byte version][12-byte IV][16-byte auth tag][ciphertext].
func decryptWithDEK(dek, blob []byte) ([]byte, error) {
	if len(dek) != dekBytes {
		return nil, fmt.Errorf("m365: dek must be %d bytes, got %d", dekBytes, len(dek))
	}
	minLen := 1 + envelopeIVBytes + envelopeTagBytes
	if len(blob) < minLen {
		return nil, fmt.Errorf("m365: envelope blob too short (%d bytes, need at least %d)", len(blob), minLen)
	}
	if blob[0] != envelopeVersion {
		return nil, fmt.Errorf("m365: unsupported envelope version %d", blob[0])
	}
	iv := blob[1 : 1+envelopeIVBytes]
	tag := blob[1+envelopeIVBytes : 1+envelopeIVBytes+envelopeTagBytes]
	ciphertext := blob[1+envelopeIVBytes+envelopeTagBytes:]
	return aesGCMOpen(dek, iv, tag, ciphertext)
}

// encryptWithDEK is the exact inverse of decryptWithDEK — used only when a
// refreshed access/refresh token pair needs to be re-encrypted and written
// back to connectors.credentials with the SAME DEK that was already
// unwrapped to read the old value (tenant_deks itself never changes here;
// see credentials.go — this package never generates or wraps a new DEK,
// that happens exactly once, in TS, on first OAuth connect).
func encryptWithDEK(dek, plaintext []byte, randIV func() ([]byte, error)) ([]byte, error) {
	if len(dek) != dekBytes {
		return nil, fmt.Errorf("m365: dek must be %d bytes, got %d", dekBytes, len(dek))
	}
	iv, err := randIV()
	if err != nil {
		return nil, fmt.Errorf("m365: generating IV: %w", err)
	}
	ciphertext, tag, err := aesGCMSeal(dek, iv, plaintext)
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, 1+len(iv)+len(tag)+len(ciphertext))
	out = append(out, envelopeVersion)
	out = append(out, iv...)
	out = append(out, tag...)
	out = append(out, ciphertext...)
	return out, nil
}

func aesGCMOpen(key, iv, tag, ciphertext []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("m365: constructing AES cipher: %w", err)
	}
	gcm, err := cipher.NewGCMWithTagSize(block, envelopeTagBytes)
	if err != nil {
		return nil, fmt.Errorf("m365: constructing GCM: %w", err)
	}
	// Go's cipher.AEAD.Open expects ciphertext||tag concatenated, whereas
	// this wire format carries the tag BEFORE the ciphertext (matching
	// node:crypto's separate getAuthTag() call) — reassembled here rather
	// than changing the wire format, since TS already owns it.
	sealed := append(append([]byte{}, ciphertext...), tag...)
	return gcm.Open(nil, iv, sealed, nil)
}

func aesGCMSeal(key, iv, plaintext []byte) (ciphertext, tag []byte, err error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, nil, fmt.Errorf("m365: constructing AES cipher: %w", err)
	}
	gcm, err := cipher.NewGCMWithTagSize(block, envelopeTagBytes)
	if err != nil {
		return nil, nil, fmt.Errorf("m365: constructing GCM: %w", err)
	}
	sealed := gcm.Seal(nil, iv, plaintext, nil)
	ciphertext = sealed[:len(sealed)-envelopeTagBytes]
	tag = sealed[len(sealed)-envelopeTagBytes:]
	return ciphertext, tag, nil
}
