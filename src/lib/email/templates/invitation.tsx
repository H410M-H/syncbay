import * as React from 'react';
import { Html, Head, Body, Container, Section, Text, Button, Hr, Preview, Tailwind, Img } from '@react-email/components';

export interface InvitationEmailProps {
  inviteeEmail: string;
  inviterName: string;
  teamName: string;
  acceptUrl: string;
}

export const InvitationEmail = ({ 
  inviteeEmail = 'user@example.com',
  inviterName = 'Jane Doe',
  teamName = 'Acme Corp',
  acceptUrl = 'https://syncbay.app/invite/accept/123'
}: InvitationEmailProps) => {
  return (
    <Html>
      <Head />
      <Preview>{`Join ${teamName} on SyncBay`}</Preview>
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
              <Text className="text-xl font-semibold mb-4 text-white">Join {teamName}</Text>
              <Text className="text-[#a1a1aa] mb-6 leading-relaxed">
                <strong className="text-white">{inviterName}</strong> has invited <strong className="text-white">{inviteeEmail}</strong> to join the <strong className="text-white">{teamName}</strong> workspace on SyncBay.
              </Text>
              <Section className="text-center mt-6 mb-6">
                <Button 
                  href={acceptUrl}
                  className="bg-[#fafafa] text-[#09090b] font-medium px-6 py-3 rounded-md text-sm"
                >
                  Accept Invitation
                </Button>
              </Section>
              <Text className="text-[#a1a1aa] leading-relaxed text-sm">
                If you were not expecting this invitation, you can ignore this email.
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

export default InvitationEmail;
