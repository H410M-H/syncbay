import * as React from 'react';
import { Html, Head, Body, Container, Section, Text, Button, Hr, Preview, Tailwind } from '@react-email/components';

export interface BillingAlertEmailProps {
  amount: string;
  invoiceUrl: string;
  description: string;
  date: string;
}

export const BillingAlertEmail = ({ 
  amount = '$49.00',
  invoiceUrl = 'https://syncbay.app/billing/invoices/123',
  description = 'SyncBay Pro Plan - Monthly',
  date = 'Oct 1, 2026'
}: BillingAlertEmailProps) => {
  return (
    <Html>
      <Head />
      <Preview>{`Your recent invoice from SyncBay: ${amount}`}</Preview>
      <Tailwind>
        <Body className="bg-[#09090b] text-[#fafafa] font-sans">
          <Container className="mx-auto p-4 max-w-2xl">
            <Section className="mt-8 mb-8 text-center">
              <Text className="text-3xl font-bold tracking-tight m-0">SyncBay</Text>
            </Section>
            <Section className="bg-[#18181b] border border-[#27272a] rounded-lg p-8">
              <Text className="text-xl font-semibold mb-4 text-white">Payment Receipt</Text>
              <Text className="text-[#a1a1aa] mb-6 leading-relaxed">
                Thank you for your continued support! We&apos;ve successfully processed your payment.
              </Text>
              
              <Section className="bg-[#09090b] rounded p-6 mb-6 border border-[#27272a]">
                <Text className="text-3xl font-bold text-white text-center m-0 mb-4">{amount}</Text>
                <Hr className="border-[#27272a] mb-4" />
                <Text className="text-sm text-[#a1a1aa] m-0 mb-2 flex justify-between">
                  <span>Description:</span> <span className="text-white">{description}</span>
                </Text>
                <Text className="text-sm text-[#a1a1aa] m-0 flex justify-between">
                  <span>Date:</span> <span className="text-white">{date}</span>
                </Text>
              </Section>

              <Section className="text-center mt-6 mb-6">
                <Button 
                  href={invoiceUrl}
                  className="bg-[#fafafa] text-[#09090b] font-medium px-6 py-3 rounded-md text-sm"
                >
                  View Invoice Details
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

export default BillingAlertEmail;
