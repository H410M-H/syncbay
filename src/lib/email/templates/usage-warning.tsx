import * as React from 'react';
import { Html, Head, Body, Container, Section, Text, Button, Hr, Preview, Tailwind, Img } from '@react-email/components';

export interface UsageWarningEmailProps {
  percentage: number;
  metricName: string;
  limit: string;
  currentUsage: string;
  upgradeUrl: string;
}

export const UsageWarningEmail = ({ 
  percentage = 80,
  metricName = 'Compute Hours',
  limit = '1000 hours',
  currentUsage = '800 hours',
  upgradeUrl = 'https://syncbay.app/billing/upgrade'
}: UsageWarningEmailProps) => {
  const isCritical = percentage >= 100;
  const warningColor = isCritical ? 'text-red-400' : 'text-amber-400';
  
  return (
    <Html>
      <Head />
      <Preview>{`Action Required: ${percentage}% usage reached for ${metricName}`}</Preview>
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
              <Text className="text-xl font-semibold mb-4 text-white">
                Usage Alert: <span className={warningColor}>{percentage}% Reached</span>
              </Text>
              <Text className="text-[#a1a1aa] mb-6 leading-relaxed">
                {isCritical 
                  ? `You have exceeded your plan's limit for ${metricName}. To ensure uninterrupted service, please upgrade your plan immediately.`
                  : `You are approaching your plan's limit for ${metricName}. Consider upgrading your plan to avoid any service interruption.`
                }
              </Text>
              
              <Section className="bg-[#09090b] rounded p-6 mb-6 border border-[#27272a]">
                <Text className="text-sm text-[#a1a1aa] m-0 mb-2">Metric: <strong className="text-white">{metricName}</strong></Text>
                <Text className="text-sm text-[#a1a1aa] m-0 mb-2">Current Usage: <strong className="text-white">{currentUsage}</strong></Text>
                <Text className="text-sm text-[#a1a1aa] m-0">Plan Limit: <strong className="text-white">{limit}</strong></Text>
                
                <div className="w-full bg-[#27272a] h-2 rounded-full mt-4 overflow-hidden">
                  <div 
                    className={`h-full ${isCritical ? 'bg-red-500' : 'bg-amber-500'}`} 
                    style={{ width: `${Math.min(percentage, 100)}%` }} 
                  />
                </div>
              </Section>

              <Section className="text-center mt-6 mb-6">
                <Button 
                  href={upgradeUrl}
                  className="bg-[#fafafa] text-[#09090b] font-medium px-6 py-3 rounded-md text-sm"
                >
                  Upgrade Plan
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

export default UsageWarningEmail;
