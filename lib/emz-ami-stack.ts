import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as fs from "fs";

export class EmzAmiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const buildComponent = new cdk.aws_imagebuilder.CfnComponent(
      this,
      "EmzAmiBuildComponent",
      {
        name: "EmzAmiBuildComponent",
        version: "1.0.3",
        platform: "Linux",
        data: fs.readFileSync("./lib/build.yml", "utf8"),
      }
    );

    const recipe = new cdk.aws_imagebuilder.CfnImageRecipe(
      this,
      "EmzAmiRecipe",
      {
        name: "EmzAmiRecipe",
        version: "1.0.3",
        components: [{ componentArn: buildComponent.attrArn }],
        parentImage: "ami-0265fbea221288607",
      }
    );

    const role = new cdk.aws_iam.Role(this, "EmzAmiRole", {
      assumedBy: new cdk.aws_iam.ServicePrincipal("ec2.amazonaws.com"),
    });
    role.addManagedPolicy(
      cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName(
        "AmazonSSMManagedInstanceCore"
      )
    );
    role.addManagedPolicy(
      cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName(
        "EC2InstanceProfileForImageBuilder"
      )
    );
    role.addManagedPolicy(
      cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonS3FullAccess")
    );

    const instanceProfile = new cdk.aws_iam.CfnInstanceProfile(
      this,
      "EmzAmiInstanceProfile",
      {
        instanceProfileName: "EmzAmiInstanceProfile",
        roles: [role.roleName],
      }
    );

    const infraConfig = new cdk.aws_imagebuilder.CfnInfrastructureConfiguration(
      this,
      "EmzAmiInfraConfig",
      {
        name: "EmzAmiInfraConfig",
        instanceProfileName: instanceProfile.instanceProfileName!,
        instanceTypes: ["t4g.small"],
        logging: {
          s3Logs: {
            s3BucketName: "ebay-temporary-files-autodelete",
            s3KeyPrefix: "EmzAmiInfraConfig",
          },
        },
      }
    );
    infraConfig.addDependency(instanceProfile);

    const pipeline = new cdk.aws_imagebuilder.CfnImagePipeline(
      this,
      "EmzAmiPipeline",
      {
        name: "EmzAmiPipeline",
        imageRecipeArn: recipe.attrArn,
        infrastructureConfigurationArn: infraConfig.attrArn,
      }
    );
    pipeline.addDependency(infraConfig);
  }
}
