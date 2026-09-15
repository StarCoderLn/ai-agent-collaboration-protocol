package credentials

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/binary"
	"testing"

	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/request"
	"github.com/aws/aws-sdk-go/service/kms"
)

type fakeKMS struct{ key []byte }

func (f fakeKMS) DecryptWithContext(aws.Context, *kms.DecryptInput, ...request.Option) (*kms.DecryptOutput, error) {
	return &kms.DecryptOutput{Plaintext: append([]byte(nil), f.key...)}, nil
}

func TestEnvelopeDecryptorReadsMarketplaceAPIFormatWithoutExposingCiphertext(t *testing.T) {
	key := []byte("12345678901234567890123456789012")
	secret := "agent-hmac-secret"
	packed := encryptedFixture(t, key, secret)
	decrypted, err := (EnvelopeDecryptor{KMS: fakeKMS{key: key}}).DecryptCredential(context.Background(), packed)
	if err != nil || decrypted != secret {
		t.Fatalf("decrypt Marketplace API envelope: secret=%q err=%v", decrypted, err)
	}
	if _, err = (EnvelopeDecryptor{KMS: fakeKMS{key: key}}).DecryptCredential(context.Background(), packed[:len(packed)-4]); err == nil {
		t.Fatal("truncated or tampered envelope must be rejected")
	}
}

func encryptedFixture(t *testing.T, key []byte, secret string) string {
	t.Helper()
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	var gcm cipher.AEAD
	gcm, err = cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	iv := []byte("123456789012")
	sealed := gcm.Seal(nil, iv, []byte(secret), nil)
	ciphertext, tag := sealed[:len(sealed)-authTagLength], sealed[len(sealed)-authTagLength:]
	encryptedKey := []byte("kms-encrypted-data-key")
	header := make([]byte, headerLength)
	header[0] = formatVersion
	binary.BigEndian.PutUint32(header[1:], uint32(len(encryptedKey)))
	packed := append(header, encryptedKey...)
	packed = append(packed, iv...)
	packed = append(packed, tag...)
	packed = append(packed, ciphertext...)
	return base64.StdEncoding.EncodeToString(packed)
}
