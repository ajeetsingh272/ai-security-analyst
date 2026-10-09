package google

import (
	"crypto/aes"
	"crypto/cipher"
	"fmt"
)

// The Go mirror of packages/db/src/crypto/envelope.ts's byte layout — same
// format m365's own envelope.go already mirrors, duplicated here rather
// than shared because each connector package is a self-contained unit (see
// docs/architecture/connector-developer-guide.md's quickstart) and this is
// plain, stable, already-reviewed crypto glue, not business logic worth a
// shared dependency between them.
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
		return nil, fmt.Errorf("google: dek must be %d bytes, got %d", dekBytes, len(dek))
	}
	minLen := 1 + envelopeIVBytes + envelopeTagBytes
	if len(blob) < minLen {
		return nil, fmt.Errorf("google: envelope blob too short (%d bytes, need at least %d)", len(blob), minLen)
	}
	if blob[0] != envelopeVersion {
		return nil, fmt.Errorf("google: unsupported envelope version %d", blob[0])
	}
	iv := blob[1 : 1+envelopeIVBytes]
	tag := blob[1+envelopeIVBytes : 1+envelopeIVBytes+envelopeTagBytes]
	ciphertext := blob[1+envelopeIVBytes+envelopeTagBytes:]
	return aesGCMOpen(dek, iv, tag, ciphertext)
}

// encryptWithDEK is the exact inverse of decryptWithDEK — used only when a
// refreshed access/refresh token pair needs to be re-encrypted and written
// back to connectors.credentials with the SAME DEK already unwrapped to
// read the old value.
func encryptWithDEK(dek, plaintext []byte, randIV func() ([]byte, error)) ([]byte, error) {
	if len(dek) != dekBytes {
		return nil, fmt.Errorf("google: dek must be %d bytes, got %d", dekBytes, len(dek))
	}
	iv, err := randIV()
	if err != nil {
		return nil, fmt.Errorf("google: generating IV: %w", err)
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
		return nil, fmt.Errorf("google: constructing AES cipher: %w", err)
	}
	gcm, err := cipher.NewGCMWithTagSize(block, envelopeTagBytes)
	if err != nil {
		return nil, fmt.Errorf("google: constructing GCM: %w", err)
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
		return nil, nil, fmt.Errorf("google: constructing AES cipher: %w", err)
	}
	gcm, err := cipher.NewGCMWithTagSize(block, envelopeTagBytes)
	if err != nil {
		return nil, nil, fmt.Errorf("google: constructing GCM: %w", err)
	}
	sealed := gcm.Seal(nil, iv, plaintext, nil)
	ciphertext = sealed[:len(sealed)-envelopeTagBytes]
	tag = sealed[len(sealed)-envelopeTagBytes:]
	return ciphertext, tag, nil
}
