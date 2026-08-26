# AICP Ethereum Escrow

Foundry + OpenZeppelin implementation for feature 5. The contract accepts native ETH and keeps
pause, automated settlement, and treasury configuration under three independent roles.

Install the pinned dependencies locally before building. `--no-git` keeps generated dependency
checkouts out of the parent repository; `lib/`, build output, cache, and broadcast records are
ignored intentionally.

```bash
forge install OpenZeppelin/openzeppelin-contracts@v5.7.0 --no-git
forge install foundry-rs/forge-std@v1.16.2 --no-git
```

```bash
forge test
forge script script/DeployEscrow.s.sol:DeployEscrow --rpc-url sepolia --broadcast
```

Deployment reads `ESCROW_ADMIN`, `ESCROW_OPERATOR`, `ESCROW_PAUSER`, `ESCROW_TREASURY`, and
`ESCROW_FEE_RECEIVER`. The script prints the deployed address; the ABI is generated at
`out/Escrow.sol/Escrow.json`. Never put a raw operator private key in this repository; production
signing must use the KMS/HSM boundary described by feature 5/6.
