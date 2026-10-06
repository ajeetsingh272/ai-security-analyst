package m365

import (
	"encoding/base64"
	"encoding/json"
	"testing"
)

// T2's underlying mechanism (P1-02's envelope format, read from Go for the
// first time): proves this Go port decrypts REAL ciphertext produced by
// node:crypto's aes-256-gcm using packages/db/src/crypto/{envelope,kms}.ts's
// exact byte layout — not just Go round-tripping against itself, which
// would miss a tag-placement or IV-length mismatch between the two
// languages' GCM implementations. Fixture generated once via a standalone
// Node script using the same algorithm those two files use; the base64
// values below are its real output, not hand-constructed.
func TestDecryptWithDEK_InteropWithNodeCrypto(t *testing.T) {
	masterKey, err := base64.StdEncoding.DecodeString("TUFTVEVSX0tFWV8zMl9CWVRFU19GT1JfRklYVFVSRSE=")
	if err != nil {
		t.Fatal(err)
	}
	wrappedDek, err := base64.StdEncoding.DecodeString("m0jLiUBlMQ33FZiMOS3MtitYUxjS/x/xEfcHmQ6Cwbv5YGMCElxUve1A2L/LveofmvuOzmfgnBV7uT81")
	if err != nil {
		t.Fatal(err)
	}
	encryptedCreds, err := base64.StdEncoding.DecodeString("ATCS5kIwemiwwMlgtoQ4DboEivwdlHPPsOsjSUJ3Rop+GZoUrdQ2hq6ekr10/HHVyX2pM03WoV9ZmSp0f4ACl/sxi113UHdZatfqv91dmB/tIgeub6pImWKxyoHGIAqWlfTOu4pxnBgGbbm6Gc+74GWmtZ0+rJ37XjBWwgVRBem0MqEMh+GX2DVGrrh0Ag7wveDdc45/TwznMTNVBNGS+E/+lBjUySXjxNpLw+W0DsW6JoHdu4R6")
	if err != nil {
		t.Fatal(err)
	}
	const expectedPlaintext = `{"accessToken":"fixture-access-token","refreshToken":"fixture-refresh-token","expiresAt":1999999999,"scope":"https://manage.office.com/ActivityFeed.Read"}`

	kms, err := newLocalKMS(masterKey)
	if err != nil {
		t.Fatalf("newLocalKMS: %v", err)
	}
	dek, err := kms.unwrapDEK(wrappedDek, localKMSKeyID)
	if err != nil {
		t.Fatalf("unwrapDEK: %v", err)
	}
	plaintext, err := decryptWithDEK(dek, encryptedCreds)
	if err != nil {
		t.Fatalf("decryptWithDEK: %v", err)
	}
	if string(plaintext) != expectedPlaintext {
		t.Fatalf("decrypted plaintext mismatch:\n got: %s\nwant: %s", plaintext, expectedPlaintext)
	}

	var creds Credentials
	if err := json.Unmarshal(plaintext, &creds); err != nil {
		t.Fatalf("unmarshalling decrypted credentials: %v", err)
	}
	if creds.AccessToken != "fixture-access-token" {
		t.Fatalf("AccessToken = %q", creds.AccessToken)
	}
}

// Round-trips purely within Go — proves encryptWithDEK/decryptWithDEK and
// wrapDEK-less re-encryption (the half this package DOES implement, for
// writing a refreshed token back) are each other's exact inverse.
func TestEncryptDecryptWithDEK_RoundTrip(t *testing.T) {
	dek := make([]byte, dekBytes)
	for i := range dek {
		dek[i] = byte(i)
	}
	plaintext := []byte(`{"accessToken":"a","refreshToken":"b","expiresAt":1,"scope":"c"}`)

	blob, err := encryptWithDEK(dek, plaintext, randomIV)
	if err != nil {
		t.Fatalf("encryptWithDEK: %v", err)
	}
	got, err := decryptWithDEK(dek, blob)
	if err != nil {
		t.Fatalf("decryptWithDEK: %v", err)
	}
	if string(got) != string(plaintext) {
		t.Fatalf("round trip mismatch: got %s want %s", got, plaintext)
	}
}

func TestDecryptWithDEK_WrongKeyFails(t *testing.T) {
	dek := make([]byte, dekBytes)
	wrongDek := make([]byte, dekBytes)
	wrongDek[0] = 1
	blob, err := encryptWithDEK(dek, []byte("secret"), randomIV)
	if err != nil {
		t.Fatalf("encryptWithDEK: %v", err)
	}
	if _, err := decryptWithDEK(wrongDek, blob); err == nil {
		t.Fatal("expected decryption with the wrong DEK to fail, it succeeded")
	}
}

func TestDecryptWithDEK_TamperedCiphertextFails(t *testing.T) {
	dek := make([]byte, dekBytes)
	blob, err := encryptWithDEK(dek, []byte("secret"), randomIV)
	if err != nil {
		t.Fatalf("encryptWithDEK: %v", err)
	}
	blob[len(blob)-1] ^= 0xFF // flip a ciphertext bit
	if _, err := decryptWithDEK(dek, blob); err == nil {
		t.Fatal("expected decryption of tampered ciphertext to fail, it succeeded")
	}
}
