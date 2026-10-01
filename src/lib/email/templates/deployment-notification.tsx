import * as React from 'react';
import { Html, Head, Body, Container, Section, Text, Button, Hr, Preview, Tailwind, Img } from '@react-email/components';

export interface DeploymentNotificationEmailProps {
  projectName: string;
  deploymentUrl: string;
  status: 'success' | 'failure';
  commitMessage?: string;
  commitHash?: string;
  errorLog?: string;
}

export const DeploymentNotificationEmail = ({ 
  projectName = 'My Project',
  deploymentUrl = 'https://syncbay.app/projects/my-project/deployments/123',
  status = 'success',
  commitMessage = 'Fix critical bug',
  commitHash = '1234567',
  errorLog
}: DeploymentNotificationEmailProps) => {
  const isSuccess = status === 'success';
  const statusColor = isSuccess ? 'text-emerald-400' : 'text-red-400';
  
  return (
    <Html>
      <Head />
      <Preview>{`Deployment ${isSuccess ? 'Successful' : 'Failed'} for ${projectName}`}</Preview>
      <Tailwind>
        <Body className="bg-[#09090b] text-[#fafafa] font-sans">
          <Container className="mx-auto p-4 max-w-2xl">
            <Section className="mt-8 mb-8 text-center">
              <Img
                src="https://www.syncbay.app/brand-logo.png"
                alt="Syncbay"
                width="220"
                height="59"
                className="mx-auto"
                style={{ margin: "0 auto", display: "block" }}
              />
            </Section>
            <Section className="bg-[#18181b] border border-[#27272a] rounded-lg p-8">
              <Text className="text-xl font-semibold mb-2 text-white">
                Deployment <span className={statusColor}>{isSuccess ? 'Successful' : 'Failed'}</span>
              </Text>
              <Text className="text-[#a1a1aa] mb-6">
                Project: <strong className="text-white">{projectName}</strong>
              </Text>
              
              <Section className="bg-[#09090b] rounded p-4 mb-6 border border-[#27272a]">
                <Text className="text-sm text-[#a1a1aa] m-0 mb-1">Commit {commitHash?.substring(0, 7)}</Text>
                <Text className="text-sm text-white m-0 font-medium">{commitMessage}</Text>
              </Section>
              
              {!isSuccess && errorLog && (
                <Section className="bg-red-950/30 border border-red-900/50 rounded p-4 mb-6">
                  <Text className="text-xs text-red-200 font-mono whitespace-pre-wrap m-0">
                    {errorLog}
                  </Text>
                </Section>
              )}

              <Section className="text-center mt-6 mb-6">
                <Button 
                  href={deploymentUrl}
                  className="bg-[#fafafa] text-[#09090b] font-medium px-6 py-3 rounded-md text-sm"
                >
                  View Deployment
                </Button>
              </Section>
            </Section>
            <Section className="mt-8 text-center">
              <Hr className="border-[#27272a] mb-6" />
              <Text className="text-[#71717a] text-xs">
                Syncbay Technologies Inc., 548 Market St, Suite 82194, San Francisco, CA 94104
              </Text>
            </Section>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
};

export default DeploymentNotificationEmail;
