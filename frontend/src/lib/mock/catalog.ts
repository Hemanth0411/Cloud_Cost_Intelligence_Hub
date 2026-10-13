import type { Environment, MockAccount, MockProvider, MockService, ProviderId, ServiceCategory } from '@/types/domain';

export const PROVIDERS: MockProvider[] = [
  { id: 'aws', name: 'Amazon Web Services', status: 'connected', lastSyncedAt: '2026-10-12T04:00:00Z' },
  { id: 'azure', name: 'Microsoft Azure', status: 'connected', lastSyncedAt: '2026-10-12T03:55:00Z' },
  { id: 'gcp', name: 'Google Cloud', status: 'degraded', lastSyncedAt: '2026-10-12T01:20:00Z' },
];

interface ServiceDef {
  id: string;
  providerId: ProviderId;
  /**
   * EXACTLY what the provider's cost API returns for this service, because
   * that is what the live app will show.
   *
   * AWS: the SERVICE dimension of Cost Explorer GetCostAndUsage, which
   * `backend/costhub/ingest/cost_explorer.py` writes to `service_name`
   * verbatim -- so it is "Amazon Relational Database Service", never "RDS".
   * Azure: Cost Management's ServiceName / MeterCategory, the fallback chain
   * in `azure_parse.py`. GCP: the billing export's `service.description`.
   *
   * These are long. Charts shorten them with `compactServiceLabel`, which
   * works the same way on live rows; tables, tooltips and exports show the
   * full value. Do NOT shorten them here -- a mock that invents friendly
   * names hides the fact that live mode has to render these.
   */
  name: string;
  category: ServiceCategory;
  /** Typical daily cost (USD) for a unit-scale account. Generator-only. */
  baseDailyCost: number;
}

const SERVICE_DEFS: ServiceDef[] = [
  // ---- AWS ------------------------------------------------------------------
  { id: 'aws-ec2', providerId: 'aws', name: 'Amazon Elastic Compute Cloud - Compute', category: 'compute', baseDailyCost: 1430 },
  // EKS bills the CONTROL PLANE only ($0.10 per cluster-hour); worker nodes
  // bill as EC2. A four-figure daily EKS line would mean several hundred
  // clusters, so this is deliberately small and sits in the long tail.
  { id: 'aws-eks', providerId: 'aws', name: 'Amazon Elastic Kubernetes Service', category: 'compute', baseDailyCost: 26 },
  { id: 'aws-lambda', providerId: 'aws', name: 'AWS Lambda', category: 'compute', baseDailyCost: 170 },
  { id: 'aws-s3', providerId: 'aws', name: 'Amazon Simple Storage Service', category: 'storage', baseDailyCost: 340 },
  { id: 'aws-rds', providerId: 'aws', name: 'Amazon Relational Database Service', category: 'database', baseDailyCost: 740 },
  { id: 'aws-redshift', providerId: 'aws', name: 'Amazon Redshift', category: 'analytics', baseDailyCost: 480 },
  { id: 'aws-glue', providerId: 'aws', name: 'AWS Glue', category: 'analytics', baseDailyCost: 300 },
  { id: 'aws-cloudfront', providerId: 'aws', name: 'Amazon CloudFront', category: 'network', baseDailyCost: 220 },
  { id: 'aws-datatransfer', providerId: 'aws', name: 'AWS Data Transfer', category: 'network', baseDailyCost: 270 },
  { id: 'aws-sagemaker', providerId: 'aws', name: 'Amazon SageMaker', category: 'ai-ml', baseDailyCost: 430 },
  // ---- Azure ----------------------------------------------------------------
  { id: 'azure-vm', providerId: 'azure', name: 'Virtual Machines', category: 'compute', baseDailyCost: 1030 },
  // Same control-plane story as EKS: AKS charges only for the Uptime SLA
  // ($0.10 per cluster-hour); node pools bill as Virtual Machines.
  { id: 'azure-aks', providerId: 'azure', name: 'Azure Kubernetes Service', category: 'compute', baseDailyCost: 24 },
  { id: 'azure-blob', providerId: 'azure', name: 'Storage', category: 'storage', baseDailyCost: 270 },
  { id: 'azure-sql', providerId: 'azure', name: 'SQL Database', category: 'database', baseDailyCost: 620 },
  { id: 'azure-cosmos', providerId: 'azure', name: 'Azure Cosmos DB', category: 'database', baseDailyCost: 450 },
  { id: 'azure-synapse', providerId: 'azure', name: 'Azure Synapse Analytics', category: 'analytics', baseDailyCost: 410 },
  { id: 'azure-openai', providerId: 'azure', name: 'Azure OpenAI', category: 'ai-ml', baseDailyCost: 500 },
  { id: 'azure-frontdoor', providerId: 'azure', name: 'Azure Front Door Service', category: 'network', baseDailyCost: 170 },
  // ---- Google Cloud ---------------------------------------------------------
  { id: 'gcp-gce', providerId: 'gcp', name: 'Compute Engine', category: 'compute', baseDailyCost: 1080 },
  { id: 'gcp-gke', providerId: 'gcp', name: 'Kubernetes Engine', category: 'compute', baseDailyCost: 22 },
  { id: 'gcp-gcs', providerId: 'gcp', name: 'Cloud Storage', category: 'storage', baseDailyCost: 240 },
  { id: 'gcp-cloudsql', providerId: 'gcp', name: 'Cloud SQL', category: 'database', baseDailyCost: 410 },
  { id: 'gcp-bigquery', providerId: 'gcp', name: 'BigQuery', category: 'analytics', baseDailyCost: 720 },
  { id: 'gcp-vertex', providerId: 'gcp', name: 'Vertex AI', category: 'ai-ml', baseDailyCost: 530 },
  { id: 'gcp-networking', providerId: 'gcp', name: 'Networking', category: 'network', baseDailyCost: 190 },
];

export const SERVICES: MockService[] = SERVICE_DEFS.map(({ id, providerId, name, category }) => ({
  id,
  providerId,
  name,
  category,
}));

export const SERVICE_PROFILE: Record<string, { baseDailyCost: number }> = Object.fromEntries(
  SERVICE_DEFS.map((s) => [s.id, { baseDailyCost: s.baseDailyCost }]),
);

interface AccountDef extends MockAccount {
  /** Relative size of the account (generator-only). */
  scale: number;
  serviceIds: string[];
}

const ACCOUNT_DEFS: AccountDef[] = [
  {
    id: 'aws-prod-core', providerId: 'aws', name: 'Prod Core Platform', externalId: '4821-7730-1159',
    environment: 'production', team: 'Platform Engineering', owner: 'Priya Nair', region: 'us-east-1',
    monthlyBudget: 172000, scale: 1.0,
    serviceIds: ['aws-ec2', 'aws-eks', 'aws-rds', 'aws-s3', 'aws-cloudfront', 'aws-datatransfer', 'aws-lambda'],
  },
  {
    id: 'aws-data-lake', providerId: 'aws', name: 'Data Lake', externalId: '9034-2216-8842',
    environment: 'production', team: 'Data Engineering', owner: 'Marcus Webb', region: 'us-west-2',
    monthlyBudget: 96000, scale: 0.8,
    // A data lake with no ETL line is not a data lake. Glue is also what the
    // backend's own dev seeder bills for, so the mix matches.
    serviceIds: ['aws-s3', 'aws-redshift', 'aws-glue', 'aws-lambda', 'aws-rds', 'aws-datatransfer'],
  },
  {
    id: 'aws-ml-research', providerId: 'aws', name: 'ML Research', externalId: '3377-5509-4421',
    environment: 'development', team: 'Applied ML', owner: 'Lena Fischer', region: 'us-east-2',
    monthlyBudget: 60000, scale: 0.85,
    serviceIds: ['aws-sagemaker', 'aws-ec2', 'aws-s3'],
  },
  {
    id: 'aws-staging', providerId: 'aws', name: 'Staging', externalId: '6150-9983-0217',
    environment: 'staging', team: 'Platform Engineering', owner: 'Priya Nair', region: 'us-east-1',
    monthlyBudget: 30000, scale: 0.3,
    serviceIds: ['aws-ec2', 'aws-eks', 'aws-rds', 'aws-s3', 'aws-lambda'],
  },
  {
    id: 'aws-sandbox', providerId: 'aws', name: 'Developer Sandbox', externalId: '7712-0043-6628',
    environment: 'development', team: 'Developer Experience', owner: 'Tomás Rivera', region: 'eu-west-1',
    monthlyBudget: 14000, scale: 0.18,
    serviceIds: ['aws-ec2', 'aws-s3', 'aws-rds', 'aws-lambda'],
  },
  {
    id: 'azure-enterprise-apps', providerId: 'azure', name: 'Enterprise Apps', externalId: '7c1f0a93-4d82-4b17-9ae5-2f6b84c10d35',
    environment: 'production', team: 'Business Systems', owner: 'Hannah Cole', region: 'eastus',
    monthlyBudget: 110000, scale: 0.9,
    serviceIds: ['azure-vm', 'azure-sql', 'azure-blob', 'azure-frontdoor', 'azure-aks'],
  },
  {
    id: 'azure-ai-services', providerId: 'azure', name: 'AI Services', externalId: 'b2904d61-8e5a-4c73-b1f0-57ad3e9c6482',
    environment: 'production', team: 'AI Platform', owner: 'Daniel Okafor', region: 'swedencentral',
    monthlyBudget: 80000, scale: 0.95,
    // AKS node pools bill as Virtual Machines, so an AKS account with no
    // Virtual Machines line is not a bill any Azure estate produces.
    serviceIds: ['azure-openai', 'azure-cosmos', 'azure-vm', 'azure-aks', 'azure-blob'],
  },
  {
    id: 'azure-analytics-hub', providerId: 'azure', name: 'Analytics Hub', externalId: 'c58e3b10-77f1-4a26-8d94-1e0b5fa27c63',
    environment: 'production', team: 'Data Engineering', owner: 'Marcus Webb', region: 'westeurope',
    monthlyBudget: 44000, scale: 0.7,
    serviceIds: ['azure-synapse', 'azure-blob', 'azure-sql'],
  },
  {
    id: 'azure-devtest', providerId: 'azure', name: 'Dev/Test', externalId: 'd7a36219-62c9-41b0-9f45-8c73e1d0ab56',
    environment: 'development', team: 'Developer Experience', owner: 'Tomás Rivera', region: 'westus2',
    monthlyBudget: 18000, scale: 0.2,
    serviceIds: ['azure-vm', 'azure-sql', 'azure-aks', 'azure-cosmos'],
  },
  {
    id: 'gcp-customer-web', providerId: 'gcp', name: 'Customer Web', externalId: 'ch-web-prod-4412',
    environment: 'production', team: 'Growth Engineering', owner: 'Sofia Alvarez', region: 'us-central1',
    monthlyBudget: 84000, scale: 0.95,
    serviceIds: ['gcp-gce', 'gcp-gke', 'gcp-cloudsql', 'gcp-gcs', 'gcp-networking'],
  },
  {
    id: 'gcp-bigquery-warehouse', providerId: 'gcp', name: 'BigQuery Warehouse', externalId: 'ch-bq-prod-8830',
    environment: 'production', team: 'Analytics', owner: 'Wei Zhang', region: 'us-east4',
    monthlyBudget: 55000, scale: 0.8,
    serviceIds: ['gcp-bigquery', 'gcp-gcs', 'gcp-vertex'],
  },
  {
    id: 'gcp-ml-lab', providerId: 'gcp', name: 'ML Lab', externalId: 'ch-ml-dev-2091',
    environment: 'development', team: 'Applied ML', owner: 'Lena Fischer', region: 'europe-west4',
    monthlyBudget: 24000, scale: 0.55,
    serviceIds: ['gcp-vertex', 'gcp-gce', 'gcp-gcs', 'gcp-gke'],
  },
];

export const ACCOUNTS: MockAccount[] = ACCOUNT_DEFS.map((a) => ({
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

/**
 * How much cheaper a weekend day is than a weekday, per environment.
 * Production barely moves; non-production is scheduled down.
 */
export const ENVIRONMENT_WEEKEND_FACTOR: Record<Environment, number> = {
  production: 0.93,
  staging: 0.6,
  development: 0.5,
};

/**
 * How much of its account's weekend dip a category actually experiences:
 * 1 = the full dip, 0 = flat right across the week.
 *
 * This is the difference between a BILL and a usage graph, and its absence
 * is the most obvious tell of synthetic cost data. Object storage is charged
 * on bytes stored, so a Saturday costs what the Tuesday before it cost; a
 * provisioned database instance bills 24/7 whether anyone queries it. Only
 * the elastic parts of a bill actually fall at the weekend -- autoscaled
 * compute, on-demand query scans, egress that tracks user traffic.
 */
export const CATEGORY_WEEKEND_SENSITIVITY: Record<ServiceCategory, number> = {
  /** Autoscaling groups and node pools follow the load. */
  compute: 1,
  /** On-demand scans (BigQuery, Synapse, Redshift Spectrum) follow analysts. */
  analytics: 1,
  /** Training jobs track working days; inference endpoints stay warm. */
  'ai-ml': 0.85,
  /** Egress and CDN track traffic, over a floor of replication and backups. */
  network: 0.8,
  /** Instance hours are flat; I/O, serverless tiers and dev shutdowns are not. */
  database: 0.35,
  /** Essentially flat: only the request and retrieval sliver moves. */
  storage: 0.05,
};
