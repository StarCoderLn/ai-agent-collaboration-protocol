package credentials

import (
	"context"
	"errors"
	"strings"
)

// LocalDecryptor 是显式限制在开发环境使用的凭证边界。数据库只保存
// `local-dev:<agent-id>` 标记，真正的共享密钥始终留在进程环境中。
type LocalDecryptor struct{ Secret string }

func (d LocalDecryptor) DecryptCredential(_ context.Context, marker string) (string, error) {
	if len(d.Secret) < 16 || !strings.HasPrefix(marker, "local-dev:") {
		return "", errors.New("local agent credential is unavailable")
	}
	return d.Secret, nil
}
