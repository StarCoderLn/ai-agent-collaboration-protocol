#!/usr/bin/env -S pnpm exec tsx
import { App, type Environment } from "aws-cdk-lib";
import { MarketplaceApiStack } from "../lib/marketplace-api-stack";

const app = new App();

// `exactOptionalPropertyTypes` 下不能显式赋值 undefined，按需省略键。
const env: Environment = {
	...(process.env.CDK_DEFAULT_ACCOUNT !== undefined && {
		account: process.env.CDK_DEFAULT_ACCOUNT,
	}),
	...(process.env.CDK_DEFAULT_REGION !== undefined && {
		region: process.env.CDK_DEFAULT_REGION,
	}),
};

const deploymentTarget = process.env.AICP_AWS_TARGET ?? "aws";
if (deploymentTarget !== "aws" && deploymentTarget !== "localstack") {
	throw new Error("AICP_AWS_TARGET 必须是 aws 或 localstack");
}

new MarketplaceApiStack(app, "MarketplaceApiStack", {
	env,
	deploymentTarget,
});
