package credentials

import (
	"context"
	"testing"
)

func TestLocalDecryptorRequiresExplicitMarkerAndStrongSecret(t *testing.T) {
	decryptor := LocalDecryptor{Secret: "at-least-sixteen-characters"}
	if secret, err := decryptor.DecryptCredential(context.Background(), "local-dev:agent-1"); err != nil || secret == "" {
		t.Fatalf("valid local marker was rejected: %v", err)
	}
	if _, err := decryptor.DecryptCredential(context.Background(), "real-envelope-ciphertext"); err == nil {
		t.Fatal("production ciphertext must never be interpreted as local plaintext")
	}
}
