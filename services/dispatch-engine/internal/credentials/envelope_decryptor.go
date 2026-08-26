// credentials 包包含仅供派发使用的凭证读取边界。Business API 仍不存在解密路径；只有
// 必须签署 Agent 请求的 worker 能取得明文，并且只在内存中短暂持有，绝不返回或记录。
package credentials

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"

	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/request"
	"github.com/aws/aws-sdk-go/service/kms"
)

const (
	formatVersion       = 1
	headerLength        = 5
	ivLength            = 12
	authTagLength       = 16
	maximumDataKeyBytes = 16 * 1024
)

type KMSClient interface {
	DecryptWithContext(aws.Context, *kms.DecryptInput, ...request.Option) (*kms.DecryptOutput, error)
}

type EnvelopeDecryptor struct{ KMS KMSClient }

func (d EnvelopeDecryptor) DecryptCredential(ctx context.Context, packedBase64 string) (string, error) {
	if d.KMS == nil || packedBase64 == "" {
		return "", errors.New("credential decryptor requires kms and ciphertext")
	}
	packed, err := base64.StdEncoding.DecodeString(packedBase64)
	if err != nil {
		return "", errors.New("credential envelope is not valid base64")
	}
	parts, err := unpack(packed)
	if err != nil {
		return "", err
	}
	decrypted, err := d.KMS.DecryptWithContext(ctx, &kms.DecryptInput{CiphertextBlob: parts.encryptedDataKey})
	if err != nil || decrypted == nil || len(decrypted.Plaintext) != 32 {
		return "", errors.New("kms could not decrypt credential data key")
	}
	dataKey := append([]byte(nil), decrypted.Plaintext...)
	decrypted.Plaintext = nil
	defer clearBytes(dataKey)
	block, err := aes.NewCipher(dataKey)
	if err != nil {
		return "", errors.New("credential data key is invalid")
	}
	var gcm cipher.AEAD
	gcm, err = cipher.NewGCM(block)
	if err != nil {
		return "", errors.New("credential cipher initialization failed")
	}
	sealed := make([]byte, 0, len(parts.ciphertext)+len(parts.authTag))
	sealed = append(sealed, parts.ciphertext...)
	sealed = append(sealed, parts.authTag...)
	plaintext, err := gcm.Open(nil, parts.iv, sealed, nil)
	clearBytes(sealed)
	if err != nil {
		return "", errors.New("credential authentication failed")
	}
	secret := string(plaintext)
	clearBytes(plaintext)
	return secret, nil
}

type envelopeParts struct {
	encryptedDataKey []byte
	iv               []byte
	authTag          []byte
	ciphertext       []byte
}

func unpack(packed []byte) (envelopeParts, error) {
	if len(packed) < headerLength+ivLength+authTagLength+1 || packed[0] != formatVersion {
		return envelopeParts{}, errors.New("credential envelope version or length is invalid")
	}
	keyLength := int(binary.BigEndian.Uint32(packed[1:headerLength]))
	if keyLength <= 0 || keyLength > maximumDataKeyBytes {
		return envelopeParts{}, errors.New("credential encrypted data key length is invalid")
	}
	offset := headerLength + keyLength
	if offset+ivLength+authTagLength >= len(packed) {
		return envelopeParts{}, errors.New("credential envelope is truncated")
	}
	return envelopeParts{
		encryptedDataKey: packed[headerLength:offset],
		iv:               packed[offset : offset+ivLength],
		authTag:          packed[offset+ivLength : offset+ivLength+authTagLength],
		ciphertext:       packed[offset+ivLength+authTagLength:],
	}, nil
}

func clearBytes(value []byte) {
	for index := range value {
		value[index] = 0
	}
}

func (p envelopeParts) String() string {
	// 防止错误格式化时把密文片段或未来的明文字段写进日志。
	return fmt.Sprintf("credential-envelope(key=%d,ciphertext=%d)", len(p.encryptedDataKey), len(p.ciphertext))
}
