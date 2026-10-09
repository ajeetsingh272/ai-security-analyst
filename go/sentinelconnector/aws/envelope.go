package aws

import (
	"crypto/aes"
	"crypto/cipher"
	"fmt"
)

// Byte-for-byte mirror of packages/db/src/crypto/envelope.ts, duplicated
// from go/sentinelconnector/m365's own envelope.go — see that file's doc
// comment for why each connector package carries its own copy rather than
// sharing one.
const (
	envelopeVersion  = 1
	envelopeIVBytes  = 12
	envelopeTagBytes = 16
	dekBytes         = 32
)

func decryptWithDEK(dek, blob []byte) ([]byte, error) {
	if len(dek) != dekBytes {
		return nil, fmt.Errorf("aws: dek must be %d bytes, got %d", dekBytes, len(dek))
	}
	minLen := 1 + envelopeIVBytes + envelopeTagBytes
	if len(blob) < minLen {
		return nil, fmt.Errorf("aws: envelope blob too short (%d bytes, need at least %d)", len(blob), minLen)
	}
	if blob[0] != envelopeVersion {
		return nil, fmt.Errorf("aws: unsupported envelope version %d", blob[0])
	}
	iv := blob[1 : 1+envelopeIVBytes]
	tag := blob[1+envelopeIVBytes : 1+envelopeIVBytes+envelopeTagBytes]
	ciphertext := blob[1+envelopeIVBytes+envelopeTagBytes:]
	return aesGCMOpen(dek, iv, tag, ciphertext)
}

func encryptWithDEK(dek, plaintext []byte, randIV func() ([]byte, error)) ([]byte, error) {
	if len(dek) != dekBytes {
		return nil, fmt.Errorf("aws: dek must be %d bytes, got %d", dekBytes, len(dek))
	}
	iv, err := randIV()
	if err != nil {
		return nil, fmt.Errorf("aws: generating IV: %w", err)
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
		return nil, fmt.Errorf("aws: constructing AES cipher: %w", err)
	}
	gcm, err := cipher.NewGCMWithTagSize(block, envelopeTagBytes)
	if err != nil {
		return nil, fmt.Errorf("aws: constructing GCM: %w", err)
	}
	sealed := append(append([]byte{}, ciphertext...), tag...)
	return gcm.Open(nil, iv, sealed, nil)
}

func aesGCMSeal(key, iv, plaintext []byte) (ciphertext, tag []byte, err error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, nil, fmt.Errorf("aws: constructing AES cipher: %w", err)
	}
	gcm, err := cipher.NewGCMWithTagSize(block, envelopeTagBytes)
	if err != nil {
		return nil, nil, fmt.Errorf("aws: constructing GCM: %w", err)
	}
	sealed := gcm.Seal(nil, iv, plaintext, nil)
	ciphertext = sealed[:len(sealed)-envelopeTagBytes]
	tag = sealed[len(sealed)-envelopeTagBytes:]
	return ciphertext, tag, nil
}
