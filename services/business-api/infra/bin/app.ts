#!/usr/bin/env -S npx tsx
import { App, type Environment } from "aws-cdk-lib";
import { BusinessApiStack } from "../lib/business-api-stack";

const app = new App();

// `exactOptionalPropertyTypes` 下不能显式赋值 undefined，按需省略键。
const env: Environment = {
	...(process.env.CDK_DEFAULT_ACCOUNT !== undefined && { account: process.env.CDK_DEFAULT_ACCOUNT }),
	...(process.env.CDK_DEFAULT_REGION !== undefined && { region: process.env.CDK_DEFAULT_REGION }),
};

new BusinessApiStack(app, "BusinessApiStack", { env });
