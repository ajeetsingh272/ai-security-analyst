package azure

import (
	"crypto/rand"
	"fmt"
)

const localKMSKeyID = "local-v1"

type localKMS struct {
	masterKey []byte
}

func newLocalKMS(masterKeyBase64 []byte) (*localKMS, error) {
	if len(masterKeyBase64) != dekBytes {
		return nil, fmt.Errorf("azure: KMS_LOCAL_MASTER_KEY must decode to %d bytes, got %d", dekBytes, len(masterKeyBase64))
	}
	return &localKMS{masterKey: masterKeyBase64}, nil
}

func (k *localKMS) unwrapDEK(wrapped []byte, keyID string) ([]byte, error) {
	if keyID != localKMSKeyID {
		return nil, fmt.Errorf("azure: cannot unwrap a DEK wrapped by key id %q, this instance only holds %q", keyID, localKMSKeyID)
	}
	minLen := envelopeIVBytes + envelopeTagBytes
	if len(wrapped) < minLen {
		return nil, fmt.Errorf("azure: wrapped DEK too short (%d bytes, need at least %d)", len(wrapped), minLen)
	}
	iv := wrapped[:envelopeIVBytes]
	tag := wrapped[envelopeIVBytes : envelopeIVBytes+envelopeTagBytes]
	ciphertext := wrapped[envelopeIVBytes+envelopeTagBytes:]
	return aesGCMOpen(k.masterKey, iv, tag, ciphertext)
}

func randomIV() ([]byte, error) {
	iv := make([]byte, envelopeIVBytes)
	if _, err := rand.Read(iv); err != nil {
		return nil, err
	}
	return iv, nil
}
