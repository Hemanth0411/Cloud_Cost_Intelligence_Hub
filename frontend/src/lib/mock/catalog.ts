import type { Account, Environment, Provider, ProviderId, Service, ServiceCategory } from '@/types/domain';

export const PROVIDERS: Provider[] = [
  { id: 'aws', name: 'Amazon Web Services', status: 'connected', lastSyncedAt: '2026-10-12T04:00:00Z' },
  { id: 'azure', name: 'Microsoft Azure', status: 'connected', lastSyncedAt: '2026-10-12T03:55:00Z' },
  { id: 'gcp', name: 'Google Cloud', status: 'degraded', lastSyncedAt: '2026-10-12T01:20:00Z' },
];

interface ServiceDef {
  id: string;
  providerId: ProviderId;
  name: string;
  category: ServiceCategory;
  /** Typical daily cost (USD) for a unit-scale account. Generator-only. */
  baseDailyCost: number;
  /** Price of one usage unit (USD). Generator-only. */
  unitPrice: number;
}

const SERVICE_DEFS: ServiceDef[] = [
  // AWS
  { id: 'aws-ec2', providerId: 'aws', name: 'EC2', category: 'compute', baseDailyCost: 1250, unitPrice: 0.096 },
  { id: 'aws-eks', providerId: 'aws', name: 'EKS', category: 'compute', baseDailyCost: 620, unitPrice: 0.1 },
  { id: 'aws-lambda', providerId: 'aws', name: 'Lambda', category: 'compute', baseDailyCost: 170, unitPrice: 0.0000167 },
  { id: 'aws-s3', providerId: 'aws', name: 'S3', category: 'storage', baseDailyCost: 340, unitPrice: 0.023 },
  { id: 'aws-rds', providerId: 'aws', name: 'RDS', category: 'database', baseDailyCost: 740, unitPrice: 0.171 },
  { id: 'aws-redshift', providerId: 'aws', name: 'Redshift', category: 'analytics', baseDailyCost: 480, unitPrice: 0.25 },
  { id: 'aws-cloudfront', providerId: 'aws', name: 'CloudFront', category: 'network', baseDailyCost: 220, unitPrice: 0.085 },
  { id: 'aws-datatransfer', providerId: 'aws', name: 'Data Transfer', category: 'network', baseDailyCost: 270, unitPrice: 0.09 },
  { id: 'aws-sagemaker', providerId: 'aws', name: 'SageMaker', category: 'ai-ml', baseDailyCost: 430, unitPrice: 1.26 },
  // Azure
  { id: 'azure-vm', providerId: 'azure', name: 'Virtual Machines', category: 'compute', baseDailyCost: 1030, unitPrice: 0.11 },
  { id: 'azure-aks', providerId: 'azure', name: 'AKS', category: 'compute', baseDailyCost: 550, unitPrice: 0.1 },
  { id: 'azure-blob', providerId: 'azure', name: 'Blob Storage', category: 'storage', baseDailyCost: 270, unitPrice: 0.0184 },
  { id: 'azure-sql', providerId: 'azure', name: 'Azure SQL', category: 'database', baseDailyCost: 620, unitPrice: 0.15 },
  { id: 'azure-cosmos', providerId: 'azure', name: 'Cosmos DB', category: 'database', baseDailyCost: 450, unitPrice: 0.008 },
  { id: 'azure-synapse', providerId: 'azure', name: 'Synapse Analytics', category: 'analytics', baseDailyCost: 410, unitPrice: 1.2 },
  { id: 'azure-openai', providerId: 'azure', name: 'Azure OpenAI', category: 'ai-ml', baseDailyCost: 500, unitPrice: 0.002 },
  { id: 'azure-frontdoor', providerId: 'azure', name: 'Front Door', category: 'network', baseDailyCost: 170, unitPrice: 0.083 },
  // GCP
  { id: 'gcp-gce', providerId: 'gcp', name: 'Compute Engine', category: 'compute', baseDailyCost: 910, unitPrice: 0.0475 },
  { id: 'gcp-gke', providerId: 'gcp', name: 'GKE', category: 'compute', baseDailyCost: 580, unitPrice: 0.1 },
  { id: 'gcp-gcs', providerId: 'gcp', name: 'Cloud Storage', category: 'storage', baseDailyCost: 240, unitPrice: 0.02 },
  { id: 'gcp-cloudsql', providerId: 'gcp', name: 'Cloud SQL', category: 'database', baseDailyCost: 410, unitPrice: 0.09 },
  { id: 'gcp-bigquery', providerId: 'gcp', name: 'BigQuery', category: 'analytics', baseDailyCost: 720, unitPrice: 6.25 },
  { id: 'gcp-vertex', providerId: 'gcp', name: 'Vertex AI', category: 'ai-ml', baseDailyCost: 530, unitPrice: 2.1 },
  { id: 'gcp-networking', providerId: 'gcp', name: 'Networking', category: 'network', baseDailyCost: 190, unitPrice: 0.085 },
];

export const SERVICES: Service[] = SERVICE_DEFS.map(({ id, providerId, name, category }) => ({
  id,
  providerId,
  name,
  category,
}));

export const SERVICE_PROFILE: Record<string, { baseDailyCost: number; unitPrice: number }> =
  Object.fromEntries(
    SERVICE_DEFS.map((s) => [s.id, { baseDailyCost: s.baseDailyCost, unitPrice: s.unitPrice }]),
  );

interface AccountDef extends Account {
  /** Relative size of the account (generator-only). */
  scale: number;
  serviceIds: string[];
}

const ACCOUNT_DEFS: AccountDef[] = [
  {
    id: 'aws-prod-core', providerId: 'aws', name: 'Prod Core Platform', externalId: '4821-7730-1159',
    environment: 'production', team: 'Platform Engineering', owner: 'Priya Nair', region: 'us-east-1',
    monthlyBudget: 160000, scale: 1.0,
    serviceIds: ['aws-ec2', 'aws-eks', 'aws-rds', 'aws-s3', 'aws-cloudfront', 'aws-datatransfer', 'aws-lambda'],
  },
  {
    id: 'aws-data-lake', providerId: 'aws', name: 'Data Lake', externalId: '9034-2216-8842',
    environment: 'production', team: 'Data Engineering', owner: 'Marcus Webb', region: 'us-west-2',
    monthlyBudget: 74000, scale: 0.8,
    serviceIds: ['aws-s3', 'aws-redshift', 'aws-lambda', 'aws-rds', 'aws-datatransfer'],
  },
  {
    id: 'aws-ml-research', providerId: 'aws', name: 'ML Research', externalId: '3377-5509-4421',
    environment: 'development', team: 'Applied ML', owner: 'Lena Fischer', region: 'us-east-2',
    monthlyBudget: 56000, scale: 0.85,
    serviceIds: ['aws-sagemaker', 'aws-ec2', 'aws-s3'],
  },
  {
    id: 'aws-staging', providerId: 'aws', name: 'Staging', externalId: '6150-9983-0217',
    environment: 'staging', team: 'Platform Engineering', owner: 'Priya Nair', region: 'us-east-1',
    monthlyBudget: 38000, scale: 0.3,
    serviceIds: ['aws-ec2', 'aws-eks', 'aws-rds', 'aws-s3', 'aws-lambda'],
  },
  {
    id: 'aws-sandbox', providerId: 'aws', name: 'Developer Sandbox', externalId: '7712-0043-6628',
    environment: 'development', team: 'Developer Experience', owner: 'Tomás Rivera', region: 'eu-west-1',
    monthlyBudget: 14000, scale: 0.18,
    serviceIds: ['aws-ec2', 'aws-s3', 'aws-rds', 'aws-lambda'],
  },
  {
    id: 'azure-enterprise-apps', providerId: 'azure', name: 'Enterprise Apps', externalId: 'a41f-77c2-09de',
    environment: 'production', team: 'Business Systems', owner: 'Hannah Cole', region: 'eastus',
    monthlyBudget: 118000, scale: 0.9,
    serviceIds: ['azure-vm', 'azure-sql', 'azure-blob', 'azure-frontdoor', 'azure-aks'],
  },
  {
    id: 'azure-ai-services', providerId: 'azure', name: 'AI Services', externalId: 'b92d-10aa-5e74',
    environment: 'production', team: 'AI Platform', owner: 'Daniel Okafor', region: 'swedencentral',
    monthlyBudget: 72000, scale: 0.95,
    serviceIds: ['azure-openai', 'azure-cosmos', 'azure-aks', 'azure-blob'],
  },
  {
    id: 'azure-analytics-hub', providerId: 'azure', name: 'Analytics Hub', externalId: 'c05e-3b18-77f1',
    environment: 'production', team: 'Data Engineering', owner: 'Marcus Webb', region: 'westeurope',
    monthlyBudget: 40000, scale: 0.7,
    serviceIds: ['azure-synapse', 'azure-blob', 'azure-sql'],
  },
  {
    id: 'azure-devtest', providerId: 'azure', name: 'Dev/Test', externalId: 'd7a3-62c9-1b40',
    environment: 'development', team: 'Developer Experience', owner: 'Tomás Rivera', region: 'westus2',
    monthlyBudget: 20000, scale: 0.2,
    serviceIds: ['azure-vm', 'azure-sql', 'azure-aks', 'azure-cosmos'],
  },
  {
    id: 'gcp-customer-web', providerId: 'gcp', name: 'Customer Web', externalId: 'cl-web-prod-4412',
    environment: 'production', team: 'Growth Engineering', owner: 'Sofia Alvarez', region: 'us-central1',
    monthlyBudget: 80000, scale: 0.95,
    serviceIds: ['gcp-gce', 'gcp-gke', 'gcp-cloudsql', 'gcp-gcs', 'gcp-networking'],
  },
  {
    id: 'gcp-bigquery-warehouse', providerId: 'gcp', name: 'BigQuery Warehouse', externalId: 'cl-bq-prod-8830',
    environment: 'production', team: 'Analytics', owner: 'Wei Zhang', region: 'us-east4',
    monthlyBudget: 50000, scale: 0.8,
    serviceIds: ['gcp-bigquery', 'gcp-gcs', 'gcp-vertex'],
  },
  {
    id: 'gcp-ml-lab', providerId: 'gcp', name: 'ML Lab', externalId: 'cl-ml-dev-2091',
    environment: 'development', team: 'Applied ML', owner: 'Lena Fischer', region: 'europe-west4',
    monthlyBudget: 33000, scale: 0.55,
    serviceIds: ['gcp-vertex', 'gcp-gce', 'gcp-gcs', 'gcp-gke'],
  },
];

export const ACCOUNTS: Account[] = ACCOUNT_DEFS.map((a) => ({
  id: a.id,
  providerId: a.providerId,
  name: a.name,
  externalId: a.externalId,
  environment: a.environment,
  team: a.team,
  owner: a.owner,
  region: a.region,
  monthlyBudget: a.monthlyBudget,
}));

export const ACCOUNT_GENERATION: Record<string, { scale: number; serviceIds: string[] }> =
  Object.fromEntries(ACCOUNT_DEFS.map((a) => [a.id, { scale: a.scale, serviceIds: a.serviceIds }]));

export const ENVIRONMENT_WEEKEND_FACTOR: Record<Environment, number> = {
  production: 0.93,
  staging: 0.6,
  development: 0.5,
};
