import * as cdk from 'aws-cdk-lib';
import { Certificate, CertificateValidation, isDnsValidatedCertificate } from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Protocol } from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as efs from 'aws-cdk-lib/aws-efs';
import { HostedZone } from 'aws-cdk-lib/aws-route53';
import * as cr from 'aws-cdk-lib/custom-resources';
import { FargateEfsCustomResource } from "./efs-mount-fargate-cr";


export class StatusStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Statusvpc', {
      cidr: this.node.tryGetContext('fargate_vpc_cidr')
    });
    const ecsCluster = new ecs.Cluster(this, 'StatusECSCluster', { vpc: vpc });

    const fileSystem = new efs.FileSystem(this, 'StatusEFSFileSystem', {
      vpc: vpc,
      encrypted: true,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_14_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING
    });


    const params = {
      FileSystemId: fileSystem.fileSystemId,
      PosixUser: {
        Gid: 1000,
        Uid: 1000
      },
      RootDirectory: {
        CreationInfo: {
          OwnerGid: 1000,
          OwnerUid: 1000,
          Permissions: '755'
        },
        Path: '/'
      },
      Tags: [
        {
          Key: 'Name',
          Value: 'status-data'
        }
      ]
    };

    const efsAccessPoint = new cr.AwsCustomResource(this, 'EfsAccessPoint', {
      onUpdate: {
        service: 'EFS',
        action: 'createAccessPoint',
        parameters: params,
        physicalResourceId: cr.PhysicalResourceId.of('12121212121'),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE })
    });

    efsAccessPoint.node.addDependency(fileSystem);

    const taskDef = new ecs.FargateTaskDefinition(this, "StatusTaskDef", {
      cpu: 512,
      memoryLimitMiB: 1024,
    });

    const containerDef = new ecs.ContainerDefinition(this, "StatusContainerDef", {
      image: ecs.ContainerImage.fromRegistry("louislam/uptime-kuma:1"),
      taskDefinition: taskDef
    });

    containerDef.addPortMappings({
      containerPort: 3001
    });

    const status_domain_zone_name = HostedZone.fromLookup(this, "status_domain_zone_name", { domainName: this.node.tryGetContext('status_domain_zone_name') })

    const cert = new Certificate(
      this,
      "certificate",
      {
        domainName: this.node.tryGetContext('status_domain_name'),
        validation: CertificateValidation.fromDns(status_domain_zone_name),
      }
    );

    const albFargateService = new ecs_patterns.ApplicationLoadBalancedFargateService(this, 'Service01', {
      cluster: ecsCluster,
      taskDefinition: taskDef,
      desiredCount: 2,
      listenerPort: 443,
      certificate: cert,
      redirectHTTP: true,
      domainName: this.node.tryGetContext('status_domain_name'),
      domainZone: status_domain_zone_name
    });

    const scalableTarget = albFargateService.service.autoScaleTaskCount({
      minCapacity: 2,
      maxCapacity: 4,
    });

    scalableTarget.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 75,
    });

    albFargateService.targetGroup.setAttribute('deregistration_delay.timeout_seconds', '30');
    albFargateService.targetGroup.configureHealthCheck({
      healthyHttpCodes: this.node.tryGetContext('status_health_check_port')
    })

    // Override Platform version (until Latest = 1.4.0)
    const albFargateServiceResource = albFargateService.service.node.findChild('Service') as ecs.CfnService;
    albFargateServiceResource.addPropertyOverride('PlatformVersion', '1.4.0')

    // Allow access to EFS from Fargate ECS
    fileSystem.connections.allowDefaultPortFrom(albFargateService.service.connections);

    //Custom Resource to add EFS Mount to Task Definition
    const resource = new FargateEfsCustomResource(this, 'FargateEfsCustomResource', {
      TaskDefinition: taskDef.taskDefinitionArn,
      EcsService: albFargateService.service.serviceName,
      EcsCluster: ecsCluster.clusterName,
      EfsFileSystemId: fileSystem.fileSystemId,
      EfsMountName: 'app'
    });

    resource.node.addDependency(albFargateService);
  }
}