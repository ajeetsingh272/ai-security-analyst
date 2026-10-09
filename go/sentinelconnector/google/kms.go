package google

import (
	"crypto/rand"
	"fmt"
)

// localKMSKeyID is the only key id a LocalKMS instance (either language's)
// ever produces or accepts — see packages/db/src/crypto/kms.ts's own doc
// comment for why this is a constant rather than something negotiated.
const localKMSKeyID = "local-v1"

// localKMS mirrors packages/db/src/crypto/kms.ts's LocalKMS — same master
// key, same env var, same wrapped-DEK byte layout, duplicated from m365's
// own localKMS for the same self-contained-package reason envelope.go's
// doc comment gives. Only unwrap is implemented: this package never
// creates a new tenant DEK.
type localKMS struct {
	masterKey []byte
}

func newLocalKMS(masterKeyBase64 []byte) (*localKMS, error) {
	if len(masterKeyBase64) != dekBytes {
		return nil, fmt.Errorf("google: KMS_LOCAL_MASTER_KEY must decode to %d bytes, got %d", dekBytes, len(masterKeyBase64))
	}
	return &localKMS{masterKey: masterKeyBase64}, nil
}

func (k *localKMS) unwrapDEK(wrapped []byte, keyID string) ([]byte, error) {
	if keyID != localKMSKeyID {
		return nil, fmt.Errorf("google: cannot unwrap a DEK wrapped by key id %q, this instance only holds %q", keyID, localKMSKeyID)
	}
	minLen := envelopeIVBytes + envelopeTagBytes
	if len(wrapped) < minLen {
		return nil, fmt.Errorf("google: wrapped DEK too short (%d bytes, need at least %d)", len(wrapped), minLen)
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
