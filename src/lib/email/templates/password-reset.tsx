import * as React from 'react';
import { Html, Head, Body, Container, Section, Text, Button, Hr, Preview, Tailwind } from '@react-email/components';

export interface PasswordResetEmailProps {
  resetUrl: string;
  userEmail: string;
}

export const PasswordResetEmail = ({ 
  resetUrl = 'https://syncbay.app/reset-password?token=123',
  userEmail = 'user@example.com'
}: PasswordResetEmailProps) => {
  return (
    <Html>
      <Head />
      <Preview>Reset your SyncBay password</Preview>
      <Tailwind>
        <Body className="bg-[#09090b] text-[#fafafa] font-sans">
          <Container className="mx-auto p-4 max-w-2xl">
            <Section className="mt-8 mb-8 text-center">
              <Text className="text-3xl font-bold tracking-tight m-0">SyncBay</Text>
            </Section>
            <Section className="bg-[#18181b] border border-[#27272a] rounded-lg p-8">
              <Text className="text-xl font-semibold mb-4 text-white">Reset Password</Text>
              <Text className="text-[#a1a1aa] mb-6 leading-relaxed">
                We received a request to reset the password for your SyncBay account associated with <strong className="text-white">{userEmail}</strong>.
              </Text>
              <Section className="text-center mt-6 mb-6">
                <Button 
                  href={resetUrl}
                  className="bg-[#fafafa] text-[#09090b] font-medium px-6 py-3 rounded-md text-sm"
                >
                  Reset Password
                </Button>
              </Section>
              <Text className="text-[#a1a1aa] leading-relaxed text-sm">
                If you didn&apos;t request a password reset, you can safely ignore this email. The link will expire in 1 hour.
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

export default PasswordResetEmail;
