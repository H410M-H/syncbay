import * as React from 'react';
import { Html, Head, Body, Container, Section, Text, Button, Hr, Preview, Tailwind } from '@react-email/components';

export interface WelcomeEmailProps {
  name: string;
  loginUrl: string;
}

export const WelcomeEmail = ({ name = 'User', loginUrl = 'https://syncbay.app/login' }: WelcomeEmailProps) => {
  return (
    <Html>
      <Head />
      <Preview>{`Welcome to SyncBay, ${name}!`}</Preview>
      <Tailwind>
        <Body className="bg-[#09090b] text-[#fafafa] font-sans">
          <Container className="mx-auto p-4 max-w-2xl">
            <Section className="mt-8 mb-8 text-center">
              <Text className="text-3xl font-bold tracking-tight m-0">SyncBay</Text>
            </Section>
            <Section className="bg-[#18181b] border border-[#27272a] rounded-lg p-8">
              <Text className="text-xl font-semibold mb-4 text-white">Welcome aboard, {name}! 🚀</Text>
              <Text className="text-[#a1a1aa] mb-6 leading-relaxed">
                We&apos;re thrilled to have you join SyncBay. Get ready to experience the next generation of PaaS, designed to make your deployments faster and more reliable.
              </Text>
              <Section className="text-center mt-6 mb-6">
                <Button 
                  href={loginUrl}
                  className="bg-[#fafafa] text-[#09090b] font-medium px-6 py-3 rounded-md text-sm"
                >
                  Log into your account
                </Button>
              </Section>
              <Text className="text-[#a1a1aa] leading-relaxed">
                If you have any questions or need assistance, our support team is always here to help.
              </Text>
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

export default WelcomeEmail;
